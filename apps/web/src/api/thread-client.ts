import type {
  LedgerResponse,
  RevertResult,
  RunChanges,
  Thread,
  ThreadDetail,
  ThreadKind,
} from '@agent/agent-models';

import { api } from './client';

async function readError(res: Response, fallback: string): Promise<string> {
  const body = await res.json().catch(() => ({}));
  return (body as { error?: string }).error ?? fallback;
}

/**
 * Opens a native folder dialog on the API host (where tools run).
 * Returns null if the user cancels.
 */
export async function pickWorkspaceFolder(
  initialDir?: string | null,
): Promise<string | null> {
  let res: Response;
  try {
    res = await api.request('workspace.pick', { init: {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        initialDir?.trim() ? { initialDir: initialDir.trim() } : {},
      ),
    } });
  } catch {
    throw new Error(
      'Cannot reach the agent host. Start it with npm start, then try again.',
    );
  }
  if (res.status === 204) return null;
  if (!res.ok) {
    throw new Error(
      await readError(res, `Failed to pick folder: ${res.status}`),
    );
  }
  const body = (await res.json()) as { workspaceRoot?: string };
  return body.workspaceRoot?.trim() ? body.workspaceRoot : null;
}

export async function listThreads(): Promise<Thread[]> {
  const res = await api.request('threads.list');
  if (!res.ok) {
    throw new Error(
      await readError(res, `Failed to list threads: ${res.status}`),
    );
  }
  const body = (await res.json()) as { threads: Thread[] };
  return body.threads;
}

export async function createThread(
  title: string,
  model: string,
  options?: { kind?: ThreadKind; workspaceRoot?: string },
): Promise<Thread> {
  const res = await api.request('threads.create', { init: {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title,
      model,
      ...(options?.kind ? { kind: options.kind } : {}),
      ...(options?.workspaceRoot
        ? { workspaceRoot: options.workspaceRoot }
        : {}),
    }),
  } });
  if (!res.ok) {
    throw new Error(
      await readError(res, `Failed to create thread: ${res.status}`),
    );
  }
  return res.json() as Promise<Thread>;
}

export async function fetchThread(id: string): Promise<ThreadDetail | undefined> {
  const res = await api.request('threads.get', { params: { id } });
  if (res.status === 404) return undefined;
  if (!res.ok) {
    throw new Error(
      await readError(res, `Failed to load thread: ${res.status}`),
    );
  }
  return res.json() as Promise<ThreadDetail>;
}

export async function patchThread(
  id: string,
  changes: {
    title?: string;
    model?: string;
    pinned?: boolean;
    kind?: ThreadKind;
    workspaceRoot?: string | null;
  },
): Promise<Thread> {
  const res = await api.request('threads.update', { params: { id }, init: {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(changes),
  } });
  if (!res.ok) {
    throw new Error(
      await readError(res, `Failed to update thread: ${res.status}`),
    );
  }
  return res.json() as Promise<Thread>;
}

export async function deleteThread(id: string): Promise<void> {
  const res = await api.request('threads.delete', { params: { id } });
  if (!res.ok) {
    throw new Error(
      await readError(res, `Failed to delete thread: ${res.status}`),
    );
  }
}

export async function fetchLedger(threadId: string): Promise<LedgerResponse> {
  const res = await api.request('threads.ledger', { params: { id: threadId } });
  if (!res.ok) {
    throw new Error(
      await readError(res, `Failed to load ledger: ${res.status}`),
    );
  }
  return res.json() as Promise<LedgerResponse>;
}

/* ---------- Checkpoints: what a reply changed on disk, and undo ---------- */

function runIdsQuery(runIds: string[]): string {
  return encodeURIComponent(runIds.join(','));
}

export async function fetchRunChanges(threadId: string, runIds: string[]): Promise<RunChanges> {
  const res = await api.request('threads.changes', { params: { id: threadId }, query: `runIds=${runIdsQuery(runIds)}` });
  if (!res.ok) throw new Error(await readError(res, `Failed to load changes: ${res.status}`));
  return res.json() as Promise<RunChanges>;
}

export async function fetchRunFileDiff(
  threadId: string,
  runIds: string[],
  file: string,
): Promise<{ diff: string; truncated: boolean }> {
  const res = await api.request('threads.changeDiff', {
    params: { id: threadId },
    query: `runIds=${runIdsQuery(runIds)}&path=${encodeURIComponent(file)}`,
  });
  if (!res.ok) throw new Error(await readError(res, `Failed to load the diff: ${res.status}`));
  return res.json() as Promise<{ diff: string; truncated: boolean }>;
}

export async function undoRunChanges(threadId: string, runIds: string[]): Promise<RevertResult> {
  const res = await api.request('threads.undoChanges', { params: { id: threadId }, init: {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ runIds }),
  } });
  if (!res.ok) throw new Error(await readError(res, `Undo failed: ${res.status}`));
  return res.json() as Promise<RevertResult>;
}

export function seqFromMessageId(id: string): number | undefined {
  const seq = Number(id.split('_').at(-1));
  return Number.isFinite(seq) ? seq : undefined;
}
