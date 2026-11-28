import { randomUUID } from 'node:crypto';

import type { QueuedMessage, QueuedRunRequest, RunPosture } from '@agent/agent-models';

import type { AgentService } from '../service';
import { startThreadRun } from './start-run';

/**
 * The queued message: one per thread, on disk with the thread
 * (`queued.json`), started by the host when the thread's run settles.
 * This module and `start-run.ts` import each other on purpose: a run start
 * starts the queue once that run settles, and the queue starts a run. Both
 * are used only inside function bodies, never at module load.
 */

/**
 * Threads whose queued message is being started now. Process-scoped like the
 * RunManager it guards (one service per process). The ledger reports it so a
 * client that just saw a run settle reads again for the next run.
 */
const starting = new Set<string>();

export function isQueueStarting(threadId: string): boolean {
  return starting.has(threadId);
}

/**
 * Start the thread's queued message, if it has one and nothing runs. A
 * refusal keeps it queued with the reason; there is no retry loop, and a
 * restart never calls this (a queued cloud run is not started unseen).
 */
export async function startQueued(service: AgentService, threadId: string): Promise<void> {
  if (starting.has(threadId) || service.closing()) return;
  starting.add(threadId);
  try {
    const store = await service.threads();
    const queued = await store.readQueued(threadId);
    // Another send started a run meanwhile: its own settle starts the queue.
    if (!queued || service.runs.activeRun(threadId)) return;
    const result = await startThreadRun(service, { threadId, ...queued.request });
    // Another start holds the thread (a send in flight): that run's settle starts the queue.
    if (!result.ok && result.reason === 'busy') return;
    // A message queued while this one started replaces it and stays.
    if ((await store.readQueued(threadId))?.id !== queued.id) return;
    await store.writeQueued(threadId, result.ok ? null : { ...queued, refused: result.error });
  } catch (error) {
    console.error('starting the queued message failed:', error instanceof Error ? error.message : error);
  } finally {
    starting.delete(threadId);
  }
}

export type QueueResult =
  | { ok: true; queued: QueuedMessage }
  | { ok: false; reason: 'not_found' | 'invalid'; error: string };

/** Queue a message (replacing one already queued); starts it at once when nothing runs. */
export async function queueMessage(
  service: AgentService,
  threadId: string,
  request: QueuedRunRequest,
): Promise<QueueResult> {
  const store = await service.threads();
  const thread = store.getThread(threadId);
  if (!thread) return { ok: false, reason: 'not_found', error: 'Thread not found' };
  if (thread.parentThreadId) return { ok: false, reason: 'invalid', error: 'Sub-agent threads are read-only' };
  const queued: QueuedMessage = { id: randomUUID(), request, queuedAt: new Date().toISOString() };
  await store.writeQueued(threadId, queued);
  // The run may have ended while the client decided to queue.
  if (!service.runs.activeRun(threadId)) void startQueued(service, threadId);
  return { ok: true, queued };
}

/** Take the queued message back (into the composer). Null when nothing was queued or the thread is unknown. */
export async function takeQueued(service: AgentService, threadId: string): Promise<QueuedMessage | null> {
  const store = await service.threads();
  if (!store.getThread(threadId)) return null;
  const queued = await store.readQueued(threadId);
  if (queued) await store.writeQueued(threadId, null);
  return queued;
}

/**
 * Send the queued message now: stop the run going (the queue starts once it
 * settles) or, with nothing running, start it. `posture` is the chip as it
 * is now, which wins over the one frozen at enqueue. False when nothing is queued.
 */
export async function sendQueuedNow(
  service: AgentService,
  threadId: string,
  posture: RunPosture | undefined,
): Promise<boolean> {
  const store = await service.threads();
  const queued = await store.readQueued(threadId);
  if (!queued) return false;
  // A new try: the old refusal no longer applies.
  await store.writeQueued(threadId, {
    id: queued.id,
    queuedAt: queued.queuedAt,
    request: { ...queued.request, ...(posture ? { posture } : {}) },
  });
  const active = service.runs.activeRun(threadId);
  if (active) service.runs.cancel(active.runId);
  else await startQueued(service, threadId);
  return true;
}
