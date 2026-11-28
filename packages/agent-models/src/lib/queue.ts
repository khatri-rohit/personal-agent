import { parseStartRunRequest, type StartRunRequest } from './run.js';

/**
 * The message waiting for a thread's run to end (F2). One per thread, held
 * by the host (`sessions/<id>/queued.json`) so it survives reloads and shows
 * in every tab. The host starts it when the thread's run settles; it is
 * never started by a restart.
 */
export type QueuedRunRequest = Omit<StartRunRequest, 'threadId' | 'rewindThroughSeq' | 'restoreFiles'> & {
  message: NonNullable<StartRunRequest['message']>;
};

export type QueuedMessage = {
  /** What to start: a run request with a new user message. */
  request: QueuedRunRequest;
  /** What the composer had, given back on take-back. Opaque to the host. */
  composer?: unknown;
  queuedAt: string;
  /** Why the last try to start it was refused; it stays queued until sent or taken back. */
  refused?: string;
};

/** Trust boundary for `PUT /threads/:id/queue` ({ request, composer? }). */
export function parseQueueBody(raw: unknown, threadId: string): Omit<QueuedMessage, 'queuedAt'> | string {
  if (!raw || typeof raw !== 'object') return 'request body must be an object';
  const body = raw as { request?: unknown; composer?: unknown };
  if (!body.request || typeof body.request !== 'object') return 'request is required';
  const parsed = parseStartRunRequest({ ...(body.request as object), threadId });
  if (typeof parsed === 'string') return parsed;
  const { message } = parsed;
  if (!message) return 'a queued request needs a message';
  // A queued send is a new turn on the thread as it will be: no rewind, no restore.
  const request: Partial<StartRunRequest> = { ...parsed };
  delete request.threadId;
  delete request.rewindThroughSeq;
  delete request.restoreFiles;
  return {
    request: { ...request, message },
    ...(body.composer !== undefined ? { composer: body.composer } : {}),
  };
}

/** The file's contents, or null when it is not a queued message. */
export function parseQueuedMessage(raw: unknown): QueuedMessage | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Partial<QueuedMessage>;
  if (typeof value.queuedAt !== 'string') return null;
  const parsed = parseQueueBody(value, 'queued');
  if (typeof parsed === 'string') return null;
  return {
    ...parsed,
    queuedAt: value.queuedAt,
    ...(typeof value.refused === 'string' ? { refused: value.refused } : {}),
  };
}
