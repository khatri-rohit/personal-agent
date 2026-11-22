import { Router, type Request, type Response } from 'express';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { LedgerResponse, RevertResult, RunChanges, ThreadDetail, ThreadKind } from '@agent/agent-models';
import {
  CHECKPOINT_NOT_COVERED,
  HOME_MODE,
  isWorkspaceKind,
  parseContextWindowMode,
  parseThreadKind,
} from '@agent/agent-models';
import type { ApiClientKind } from '../platform/access';
import { getAgentHome, getThreadStore, runManager } from '../platform/instances';
import { isAllowedWorkspace, rememberWorkspace, WORKSPACE_NOT_PICKED } from './workspace-allowlist';
import { folderWriter, forgetCheckpoints, revertRuns, runChanges, runFileDiff } from './checkpoints';
import { asyncRoute } from '../platform/http-errors';
import { cancelLearningReview } from '../memory/learning-loop';
import { readSettledLastRun } from '../runs/run-context';
import { pickFolderDialog } from './pick-folder';

const router = Router();

async function resolveWorkspaceDir(
  raw: string,
): Promise<{ ok: true; root: string } | { ok: false; error: string }> {
  const root = path.resolve(raw.trim());
  try {
    const info = await stat(root);
    if (!info.isDirectory()) {
      return { ok: false, error: 'workspaceRoot must be a directory' };
    }
  } catch {
    return { ok: false, error: `workspaceRoot does not exist: ${root}` };
  }
  return { ok: true, root: path.normalize(root) };
}

/**
 * A browser request may open only a folder a person chose (B1,
 * workspace-allowlist.ts); a token client may open any existing folder.
 */
async function workspaceAllowed(res: Response, root: string): Promise<boolean> {
  if ((res.locals.client as ApiClientKind | undefined) === 'token') return true;
  const store = await getThreadStore();
  return isAllowedWorkspace({
    agentHome: getAgentHome(),
    root,
    threadRoots: store.listThreads({ includeSubagents: true }).map((thread) => thread.workspaceRoot),
  });
}

/**
 * POST /api/agent/workspace/pick
 * Opens a native folder dialog on the API host and returns the absolute path.
 * 204 = cancelled, 500 = dialog failed, 200 = { workspaceRoot }.
 */
router.post('/workspace/pick', asyncRoute(async (req: Request, res: Response) => {
  const initial =
    typeof req.body?.initialDir === 'string' && req.body.initialDir.trim()
      ? path.resolve(req.body.initialDir.trim())
      : undefined;
  const picked = await pickFolderDialog(initial);
  if (!picked.ok && picked.reason === 'cancelled') {
    return res.status(204).send();
  }
  if (!picked.ok) {
    return res.status(500).json({
      error:
        picked.message ||
        'Folder picker failed. Restart the API on this machine and try again.',
    });
  }
  const resolved = await resolveWorkspaceDir(picked.path);
  if (!resolved.ok) {
    return res.status(400).json({ error: resolved.error });
  }
  // A person chose it in the dialog: browser requests may now open it.
  await rememberWorkspace(getAgentHome(), resolved.root);
  return res.json({ workspaceRoot: resolved.root });
}));

router.get('/threads', asyncRoute(async (req: Request, res: Response) => {
  const store = await getThreadStore();
  const kind = parseThreadKind(req.query.kind);
  const workspaceRoot =
    typeof req.query.workspaceRoot === 'string' &&
    req.query.workspaceRoot.trim()
      ? path.resolve(req.query.workspaceRoot.trim())
      : undefined;
  const includeSubagents = req.query.includeSubagents === 'true';
  return res.json({
    threads: store.listThreads({
      ...(kind ? { kind } : {}),
      ...(workspaceRoot ? { workspaceRoot } : {}),
      ...(includeSubagents ? { includeSubagents: true } : {}),
    }),
  });
}));

router.post('/threads', asyncRoute(async (req: Request, res: Response) => {
  const model =
    typeof req.body?.model === 'string' && req.body.model.trim()
      ? req.body.model.trim()
      : HOME_MODE.model;
  const title =
    typeof req.body?.title === 'string' && req.body.title.trim()
      ? req.body.title.trim()
      : 'New Chat';
  const kind = parseThreadKind(req.body?.kind) ?? 'home';
  let workspaceRoot: string | undefined;
  if (isWorkspaceKind(kind)) {
    const raw =
      typeof req.body?.workspaceRoot === 'string' ? req.body.workspaceRoot : '';
    if (!raw.trim()) {
      return res
        .status(400)
        .json({ error: 'workspaceRoot is required for workspace threads' });
    }
    const resolved = await resolveWorkspaceDir(raw);
    if (!resolved.ok) return res.status(400).json({ error: resolved.error });
    if (!(await workspaceAllowed(res, resolved.root))) return res.status(403).json({ error: WORKSPACE_NOT_PICKED });
    workspaceRoot = resolved.root;
  }
  const store = await getThreadStore();
  const thread = await store.createThread(model, title, {
    kind,
    workspaceRoot,
  });
  return res.status(201).json(thread);
}));

router.get('/threads/:id', asyncRoute(async (req: Request, res: Response) => {
  const store = await getThreadStore();
  const thread = store.getThread(req.params.id);
  if (!thread) return res.status(404).json({ error: 'Thread not found' });
  const profile = thread.parentThreadId
    ? store.subagentProfile(req.params.id)
    : undefined;
  const detail: ThreadDetail = {
    ...thread,
    ...(profile ? { subagentProfile: profile } : {}),
    running: Boolean(runManager.activeRun(req.params.id)),
  };
  return res.json(detail);
}));

router.patch('/threads/:id', asyncRoute(async (req: Request, res: Response) => {
  const store = await getThreadStore();
  const body = req.body as {
    title?: string;
    model?: string;
    pinned?: boolean;
    kind?: ThreadKind;
    workspaceRoot?: unknown;
    contextWindowMode?: unknown;
  };
  const contextWindowMode = parseContextWindowMode(body.contextWindowMode);
  if (
    body.workspaceRoot !== undefined &&
    body.workspaceRoot !== null &&
    typeof body.workspaceRoot !== 'string'
  ) {
    return res.status(400).json({ error: 'workspaceRoot must be a string or null' });
  }
  let workspaceRoot = body.workspaceRoot as string | null | undefined;
  if (typeof workspaceRoot === 'string' && workspaceRoot.trim()) {
    const resolved = await resolveWorkspaceDir(workspaceRoot);
    if (!resolved.ok) return res.status(400).json({ error: resolved.error });
    if (!(await workspaceAllowed(res, resolved.root))) return res.status(403).json({ error: WORKSPACE_NOT_PICKED });
    workspaceRoot = resolved.root;
  }
  const kind = parseThreadKind(body.kind);
  const thread = store.updateThread(req.params.id, {
    ...(typeof body.title === 'string' ? { title: body.title } : {}),
    ...(typeof body.model === 'string' ? { model: body.model } : {}),
    ...(typeof body.pinned === 'boolean' ? { pinned: body.pinned } : {}),
    ...(kind ? { kind } : {}),
    ...(workspaceRoot !== undefined ? { workspaceRoot } : {}),
    ...(contextWindowMode ? { contextWindowMode } : {}),
  });
  if (!thread) return res.status(404).json({ error: 'Thread not found' });
  return res.json(thread);
}));

router.delete('/threads/:id', asyncRoute(async (req: Request, res: Response) => {
  const store = await getThreadStore();
  const root = store.getThread(req.params.id)?.workspaceRoot;
  const ok = await store.deleteThread(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Thread not found' });
  cancelLearningReview(req.params.id);
  // The folder's snapshots go with its last thread.
  if (root && !store.listThreads({ includeSubagents: true }).some((thread) => thread.workspaceRoot === root)) {
    void forgetCheckpoints(getAgentHome(), root);
  }
  return res.json({ ok: true });
}));

router.get('/threads/:id/ledger', asyncRoute(async (req: Request, res: Response) => {
  const store = await getThreadStore();
  const thread = store.getThread(req.params.id);
  if (!thread) return res.status(404).json({ error: 'Thread not found' });
  const messages = await store.toUiMessages(req.params.id);
  const envelopes = await store.readLedger(req.params.id, 0);
  const lastSeq = envelopes.at(-1)?.seq ?? 0;
  const lastUserSeq = store.lastUserSeq(envelopes);
  const snapshot = await store.readSnapshot(req.params.id);
  const plan = await store.readPlan(req.params.id);
  const lastRun = await readSettledLastRun(store, req.params.id);
  const activeRun = runManager.activeRun(req.params.id);
  const ledger: LedgerResponse = {
    messages,
    lastSeq,
    ...(lastUserSeq !== undefined ? { lastUserSeq } : {}),
    snapshot,
    plan,
    ...(lastRun ? { lastRun } : {}),
    ...(activeRun ? { activeRun } : {}),
  };
  return res.json(ledger);
}));

/**
 * The runs a checkpoint request names, kept only when they are this
 * thread's runs, in ledger order (a run id becomes a git ref name, so
 * nothing else gets through).
 */
async function threadRunIds(threadId: string, raw: unknown): Promise<string[]> {
  const wanted = new Set(
    (Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : []).filter(
      (id): id is string => typeof id === 'string' && id.length > 0,
    ),
  );
  if (wanted.size === 0) return [];
  const store = await getThreadStore();
  const ordered: string[] = [];
  for (const envelope of await store.readLedger(threadId, 0)) {
    if (envelope.runId && wanted.has(envelope.runId) && !ordered.includes(envelope.runId)) ordered.push(envelope.runId);
  }
  return ordered;
}

/** GET /threads/:id/changes?runIds=a,b — what those runs changed in the folder (B3). */
router.get('/threads/:id/changes', asyncRoute(async (req: Request, res: Response) => {
  const store = await getThreadStore();
  const thread = store.getThread(req.params.id);
  if (!thread) return res.status(404).json({ error: 'Thread not found' });
  const runIds = await threadRunIds(req.params.id, req.query.runIds);
  if (!thread.workspaceRoot || runIds.length === 0) {
    return res.json({ available: false, files: [], notCovered: CHECKPOINT_NOT_COVERED } satisfies RunChanges);
  }
  return res.json(await runChanges({ agentHome: getAgentHome(), root: thread.workspaceRoot, runIds }));
}));

/** GET /threads/:id/changes/diff?runIds=a,b&path=src/x.ts — one file's diff across those runs. */
router.get('/threads/:id/changes/diff', asyncRoute(async (req: Request, res: Response) => {
  const store = await getThreadStore();
  const thread = store.getThread(req.params.id);
  if (!thread?.workspaceRoot) return res.status(404).json({ error: 'Thread not found' });
  const file = typeof req.query.path === 'string' ? req.query.path : '';
  const runIds = await threadRunIds(req.params.id, req.query.runIds);
  if (!file || runIds.length === 0) return res.status(400).json({ error: 'runIds and path are required' });
  const diff = await runFileDiff({ agentHome: getAgentHome(), root: thread.workspaceRoot, runIds, file });
  if (!diff) return res.status(404).json({ error: 'No snapshot exists for these runs' });
  return res.json(diff);
}));

/** POST /threads/:id/changes/undo { runIds } — put back what those runs changed. */
router.post('/threads/:id/changes/undo', asyncRoute(async (req: Request, res: Response) => {
  const store = await getThreadStore();
  const thread = store.getThread(req.params.id);
  if (!thread?.workspaceRoot) return res.status(404).json({ error: 'Thread not found' });
  if (runManager.activeRun(req.params.id)) {
    return res.status(409).json({ error: 'Stop the running reply before undoing file changes.' });
  }
  if (folderWriter(thread.workspaceRoot)) {
    return res.status(409).json({ error: 'Another thread is running in this folder. Undo once it finishes.' });
  }
  const runIds = await threadRunIds(req.params.id, (req.body as { runIds?: unknown } | undefined)?.runIds);
  if (runIds.length === 0) return res.status(400).json({ error: 'runIds is required' });
  try {
    const result: RevertResult = await revertRuns({ agentHome: getAgentHome(), root: thread.workspaceRoot, runIds });
    return res.json(result);
  } catch (error) {
    return res.status(409).json({ error: error instanceof Error ? error.message : String(error) });
  }
}));

export { router as threadsRouter };
