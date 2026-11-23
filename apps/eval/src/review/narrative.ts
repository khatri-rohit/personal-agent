import { createHash } from 'node:crypto';

import {
  parseReviewNarrative,
  resolveReasoningEffort,
  REVIEW_DIGEST_VERSION,
  REVIEW_DIMENSIONS,
  type ReviewNarrative,
  type ThinkingValue,
} from '@agent/agent-models';

import type { ReviewModelInput } from '@agent/agent-eval';

import { reviewerConfig, sameModel } from './models';

const DEFAULT_CLOUD_BASE_URL = 'https://ollama.com/v1';
/** The judge reads the request, the answer and the step list, and may think first: more than a 20 s call allows. */
const REVIEW_TIMEOUT_MS = 180_000;

const SYSTEM_PROMPT = `You are the judge of one thread of a personal coding agent.

You receive:
- "evidence": what the user asked (request), the agent's last answer (answer), and every tool call with its outcome (steps). This is what you judge.
- "digest": rule-based signals about the process (token counts, iterations, waste markers). They describe how the work went, not whether it was right. A digest finding is a lead to check against the evidence, not a verdict.
- "excerpts": a few short quotes.

Judge each dimension on its own, from the evidence:
- did-what-was-asked: the answer addresses what the request asked, completely. A question answered with edits, or a change request answered without changes, fails.
- verified: when files were changed, a check (build, test, typecheck, lint) ran after the last change and passed (a step "→ exit 0"); when nothing was changed, pass if the answer cites evidence (paths, lines, command output) for its claims.
- stayed-in-scope: the steps touched only what the request needed.
- efficient: the steps were not much more than the outcome needed (repeated reads or searches, serial single calls, work after the answer was known).
For each, return "pass", "fail" or "unknown". Use "unknown" whenever the evidence cannot settle it (for example the answer was clipped, or the steps do not show the outcome). Never guess.

Rules:
- Cite only what appears in the evidence, digest or excerpts. Quote numbers exactly.
- Do not invent tools, files, outcomes or intent. Do not flatter; do not inflate failures either.
- If evidence.clipped is true, say what you could not see.
- Reply with strict JSON only, no markdown:
  {"summary": string, "alignment": string, "judgment": [{"dimension": ${REVIEW_DIMENSIONS.map((d) => `"${d}"`).join('|')}, "verdict": "pass"|"fail"|"unknown", "critique": string}], "findings": [{"kind": "over-work"|"unnecessary-calls"|"misread-intent"|"waste"|"good", "text": string}], "suggestions": string[]}
- summary: 3–6 sentences, outcome first, then the process. judgment: all four dimensions, each critique one or two sentences citing a step, a quote or a number.
- suggestions: concrete, tied to a failed or unknown dimension or a finding.`;

/** sha256 of the judge's prompt: stored on every review and part of its fingerprint. */
export const REVIEW_PROMPT_SHA = createHash('sha256').update(SYSTEM_PROMPT).digest('hex').slice(0, 16);

/**
 * The judge: the model picked on the page, else REVIEW_MODEL, else the
 * thread's own model. Marked a self-review when it is the thread's model (a
 * model grading its own work is biased toward itself).
 */
export function reviewerFor(threadModel: string, picked?: string): { model: string | null; selfReview: boolean } {
  const model = picked?.trim() || process.env.REVIEW_MODEL?.trim() || threadModel.trim();
  return { model: model || null, selfReview: Boolean(model) && Boolean(threadModel.trim()) && sameModel(model, threadModel) };
}

/** The fingerprint's reviewer part: digest version, judge model and thinking, prompt. */
export function reviewerKey(model: string | null, thinking: ThinkingValue | undefined): string {
  return `${REVIEW_DIGEST_VERSION}|${model ?? 'none'}|${thinking === undefined ? 'default' : String(thinking)}|${REVIEW_PROMPT_SHA}`;
}

function extractJson(text: string): unknown {
  // Thinking models may wrap their reasoning in <think>…</think> before the JSON.
  const trimmed = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = (fenced?.[1] ?? trimmed).trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  return JSON.parse(start >= 0 && end > start ? raw.slice(start, end + 1) : raw) as unknown;
}

export type NarrativeOutcome = { narrative: ReviewNarrative; error?: undefined } | { narrative: null; error: string };

/**
 * One non-streaming completion. Never throws: a failure comes back as its
 * reason, so the page can say the judgment is missing and why.
 */
export async function generateNarrative(
  input: ReviewModelInput,
  model: string | null,
  thinking?: ThinkingValue,
): Promise<NarrativeOutcome> {
  if (!model) return { narrative: null, error: 'no reviewer model picked' };
  // The chosen level as the chat sends it (`reasoning_effort`); none for models without thinking.
  const config = await reviewerConfig(model);
  const effort = config ? resolveReasoningEffort(config, thinking) : undefined;

  const baseURL = (process.env.OLLAMA_BASE_URL ?? DEFAULT_CLOUD_BASE_URL).replace(/\/$/, '');
  if (baseURL === DEFAULT_CLOUD_BASE_URL && !process.env.OLLAMA_API_KEY) {
    return { narrative: null, error: 'OLLAMA_API_KEY is not set for the eval app' };
  }

  const user = JSON.stringify({ evidence: input.evidence ?? null, digest: input.digest, excerpts: input.excerpts }, null, 2);

  try {
    const response = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OLLAMA_API_KEY ?? 'ollama'}`,
      },
      body: JSON.stringify({
        model,
        stream: false,
        // Thinking tokens count toward max_tokens on some models: leave room for both.
        max_tokens: effort && effort !== 'none' ? 12_000 : 2_500,
        temperature: 0.2,
        ...(effort ? { reasoning_effort: effort } : {}),
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: user },
        ],
      }),
      signal: AbortSignal.timeout(REVIEW_TIMEOUT_MS),
    });
    if (!response.ok) {
      return { narrative: null, error: `${model} answered ${response.status}: ${(await response.text()).slice(0, 300)}` };
    }
    const body = (await response.json()) as { choices?: { message?: { content?: string | null } }[] };
    const content = body.choices?.[0]?.message?.content;
    if (!content) return { narrative: null, error: `${model} returned no content` };
    let parsed: unknown;
    try {
      parsed = extractJson(content);
    } catch {
      return { narrative: null, error: `${model} did not return JSON: ${content.slice(0, 200)}` };
    }
    const narrative = parseReviewNarrative(parsed);
    return narrative ? { narrative } : { narrative: null, error: `${model} returned JSON in the wrong shape` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { narrative: null, error: `${model} call failed: ${message}` };
  }
}
