'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import {
  analyzeThread,
  buildReviewInput,
  flattenRuns,
  listRuns,
  readLedger,
  reviewFingerprint,
  reviewOwnerThread,
} from '@agent/agent-eval';
import { REVIEW_DIGEST_VERSION, sameReviewFingerprint, type ThinkingValue } from '@agent/agent-models';

import { agentHome, evalHome } from '../lib/home';
import { reviewHref } from './href';
import { listReviewers, type Reviewer } from './models';
import { generateNarrative, REVIEW_PROMPT_SHA, reviewerFor, reviewerKey } from './narrative';
import { readReview, writeReview } from './store';

function safeId(value: string): string | null {
  const id = value.trim();
  if (!id || id.length > 80 || id.includes('/') || id.includes('\\') || id.includes('..')) return null;
  return id;
}

function homeOf(flag: string): string {
  return flag === 'eval' ? evalHome() : agentHome();
}

function revalidateAndReturn(threadId: string, runId: string | undefined, homeFlag: string): never {
  revalidatePath(`/threads/${threadId}`);
  revalidatePath(`/threads/${threadId}/review`);
  if (runId) revalidatePath(`/runs/${runId}`);
  redirect(reviewHref(threadId, { homeFlag, runId }));
}

/**
 * Manual-only. Matching fingerprint → stored artifact, no model call.
 * Changed thread → digest always, narrative if the model answers, else digest-only.
 */
export async function requestReview(formData: FormData): Promise<void> {
  const rawThreadId = safeId(String(formData.get('threadId') ?? ''));
  const runId = safeId(String(formData.get('runId') ?? '')) ?? undefined;
  const homeFlag = String(formData.get('home') ?? '');
  if (!rawThreadId) return;

  const home = homeOf(homeFlag);
  const { threadId, model } = reviewOwnerThread(home, rawThreadId);
  const picked = String(formData.get('model') ?? '').trim();
  const thinking = parseThinking(String(formData.get('thinking') ?? ''));
  const reviewer = reviewerFor(model, picked || undefined);
  // A new judge model, thinking level, prompt or digest code is a new review, not the stored one.
  const key = reviewerKey(reviewer.model, thinking);
  const ledger = (await readLedger(home, threadId)).envelopes;
  const runs = flattenRuns(await listRuns(home, { threadId }));
  const fingerprint = reviewFingerprint({ threadId, ledger, runs, reviewer: key });
  const stored = await readReview(home, threadId);
  // A stored review whose model call failed is retried, not served.
  if (stored && stored.narrative && sameReviewFingerprint(stored.fingerprint, fingerprint)) {
    revalidateAndReturn(threadId, runId, homeFlag);
  }

  const analysis = await analyzeThread(home, rawThreadId, runId);
  const outcome = await generateNarrative(
    buildReviewInput(analysis.digest, analysis.excerpts, analysis.evidence),
    reviewer.model,
    thinking,
  );
  await writeReview(home, {
    threadId: analysis.digest.threadId,
    fingerprint: { ...analysis.fingerprint, reviewer: key },
    createdAt: new Date().toISOString(),
    digest: analysis.digest,
    narrative: outcome.narrative,
    ...(outcome.error ? { narrativeError: outcome.error } : {}),
    provenance: {
      digestVersion: REVIEW_DIGEST_VERSION,
      model: reviewer.model,
      promptSha: REVIEW_PROMPT_SHA,
      selfReview: reviewer.selfReview,
      ...(thinking !== undefined ? { thinking } : {}),
    },
  });
  revalidateAndReturn(analysis.digest.threadId, runId, homeFlag);
}

/** Form value → thinking: `true`/`false`, a level name, or the model default (empty). */
function parseThinking(value: string): ThinkingValue | undefined {
  if (!value) return undefined;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
}

/** The judge models and their thinking levels, for the Review button's pickers. */
export async function reviewerOptions(): Promise<{ reviewers: Reviewer[]; defaultModel: string | null }> {
  return { reviewers: await listReviewers(), defaultModel: process.env.REVIEW_MODEL?.trim() || null };
}
