import {
  classifyThinking,
  middleThinking,
  type OllamaModelConfig,
  type ThinkingValue,
} from '@agent/agent-models';

/**
 * The models a Review can be judged by, from the same Ollama account the
 * chat uses (`/api/tags`, `/api/show`), with each model's thinking levels.
 * Server only. Cached for the process; a failure is an empty list, so the
 * page still offers the thread's own model.
 */

const DEFAULT_CLOUD_BASE_URL = 'https://ollama.com/v1';
const LIST_TTL_MS = 10 * 60_000;

export type Reviewer = {
  id: string;
  /** Thinking values the model accepts, as the chat's picker shows them (empty: no thinking). */
  thinking: ThinkingValue[];
  /** The middle level (`medium` of low/medium/high): the default choice. */
  middle: ThinkingValue | null;
};

function nativeBase(): string {
  return (process.env.OLLAMA_BASE_URL ?? DEFAULT_CLOUD_BASE_URL).replace(/\/v1\/?$/, '').replace(/\/$/, '');
}

function headers(): Record<string, string> {
  return process.env.OLLAMA_API_KEY ? { Authorization: `Bearer ${process.env.OLLAMA_API_KEY}` } : {};
}

const configs = new Map<string, OllamaModelConfig>();

/** One model's capabilities (`/api/show`), cached. Null when Ollama does not answer. */
export async function reviewerConfig(model: string): Promise<OllamaModelConfig | null> {
  const hit = configs.get(model);
  if (hit) return hit;
  try {
    const res = await fetch(`${nativeBase()}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers() },
      body: JSON.stringify({ model }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { capabilities?: string[]; thinking?: { values?: ThinkingValue[]; default?: ThinkingValue } };
    const capabilities = data.capabilities ?? [];
    const config: OllamaModelConfig = {
      model,
      capabilities,
      contextLength: null,
      thinking: classifyThinking(data.thinking),
      supportsTools: capabilities.includes('tools'),
      supportsVision: capabilities.includes('vision'),
    };
    configs.set(model, config);
    return config;
  } catch {
    return null;
  }
}

let listed: { at: number; reviewers: Reviewer[] } | null = null;

export async function listReviewers(): Promise<Reviewer[]> {
  if (listed && Date.now() - listed.at < LIST_TTL_MS) return listed.reviewers;
  let ids: string[] = [];
  try {
    const res = await fetch(`${nativeBase()}/api/tags`, { headers: headers(), signal: AbortSignal.timeout(10_000) });
    if (res.ok) {
      const data = (await res.json()) as { models?: Array<{ name?: string; model?: string }> };
      ids = (data.models ?? []).map((row) => (row.name ?? row.model ?? '').trim()).filter(Boolean);
    }
  } catch {
    ids = [];
  }
  const reviewers = await Promise.all(
    [...new Set(ids)].sort().map(async (id): Promise<Reviewer> => {
      const config = await reviewerConfig(id);
      const thinking = config?.thinking.supported ? config.thinking.values : [];
      return { id, thinking, middle: config ? middleThinking(config.thinking) : null };
    }),
  );
  if (reviewers.length > 0) listed = { at: Date.now(), reviewers };
  return reviewers;
}

/** `glm-5.3:cloud` and `glm-5.3` are one model (the chat's catalog adds the tag, /api/tags does not). */
export function sameModel(a: string, b: string): boolean {
  const bare = (id: string) => id.trim().replace(/:cloud$/, '');
  return bare(a) === bare(b);
}
