import { parseRunOptions, type StartRunRequest } from './run.js';

/**
 * The message waiting for a thread's run to end (F2). One per thread, held
 * by the host (`sessions/<id>/queued.json`) so it survives reloads and shows
 * in every tab. The host starts it when the thread's run settles; it is
 * never started by a restart.
 */

/** A new turn on the thread as it will be: a message, and never a rewind or a file restore. */
export type QueuedRunRequest = Omit<StartRunRequest, 'threadId' | 'rewindThroughSeq' | 'restoreFiles'> & {
  message: NonNullable<StartRunRequest['message']>;
};

export type QueuedMessage = {
  /** This queued send; a replacement gets a new one (the host checks it before clearing). */
  id: string;
  request: QueuedRunRequest;
  queuedAt: string;
  /** Why the last try to start it was refused; it stays queued until sent or taken back. */
  refused?: string;
};

/** Trust boundary for `PUT /threads/:id/queue` (a run request without thread, rewind or restore). */
export function parseQueuedRunRequest(raw: unknown): QueuedRunRequest | string {
  if (!raw || typeof raw !== 'object') return 'request body must be an object';
  const run = parseRunOptions(raw as Record<string, unknown>);
  if (typeof run === 'string') return run;
  if (run.rewindThroughSeq !== undefined || run.restoreFiles) return 'a queued message cannot rewind or restore files';
  if (!run.message) return 'a queued message needs a message';
  return { ...run, message: run.message };
}

/** `queued.json`'s contents, or null when it is not a queued message. */
export function parseQueuedMessage(raw: unknown): QueuedMessage | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.id !== 'string' || typeof value.queuedAt !== 'string') return null;
  const request = parseQueuedRunRequest(value.request);
  if (typeof request === 'string') return null;
  return {
    id: value.id,
    request,
    queuedAt: value.queuedAt,
    ...(typeof value.refused === 'string' ? { refused: value.refused } : {}),
  };
}
