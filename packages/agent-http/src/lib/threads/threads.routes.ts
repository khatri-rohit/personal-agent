import { Router, type Request, type Response } from 'express';
import { API_ROUTES } from '@agent/agent-models';
import type { AgentService } from '@agent/agent-service';
import path from 'node:path';
import type { LedgerResponse, RevertResult, RunChanges, ThreadDetail, ThreadKind } from '@agent/agent-models';
import {
  CHECKPOINT_NOT_COVERED,
  HOME_MODE,
  isWorkspaceKind,
  normalizeRunPosture,
  parseContextWindowMode,
  parseQueuedRunRequest,
  parseThreadKind,
} from '@agent/agent-models';
import type { ApiClientKind } from '../platform/access';

import {
  rememberWorkspace,
  resolveWorkspaceDir,
  threadRunIds,
  workspaceAllowed,
  WORKSPACE_NOT_PICKED,
} from '@agent/agent-service';
import { forgetCheckpoints, revertRuns, runChanges, runFileDiff } from '@agent/agent-service';
import { asyncRoute } from '../platform/http-errors';

import { isQueueStarting, queueMessage, readSettledLastRun, sendQueuedNow, takeQueued } from '@agent/agent-service';

export type PickFolderResult =
  | { ok: true; path: string }
  | { ok: false; reason: 'cancelled' }
  | { ok: false; reason: 'error'; message: string };

/** A native folder dialog on the machine that runs the tools (an OS port; `apps/agent` provides it). */
export type PickFolder = (initialDir?: string) => Promise<PickFolderResult>;

const noFolderPicker: PickFolder = async () => ({
  ok: false,
  reason: 'error',
  message: 'This host has no folder picker.',
});

/** A local process that presented the API token (platform/access.ts), not a browser page. */
function isTokenClient(res: Response): boolean {
  return (res.locals.client as ApiClientKind | undefined) === 'token';
}

export function threadsRouter(service: AgentService, pickFolder: PickFolder = noFolderPicker): Router {
  const router = Router();

  /**
   * POST /api/agent/workspace/pick
   * Opens a native folder dialog on the API host and returns the absolute path.
   * 204 = cancelled, 500 = dialog failed, 200 = { workspaceRoot }.
   */
  router.post(API_ROUTES['workspace.pick'].path, asyncRoute(async (req: Request, res: Response) => {
    const initial =
      typeof req.body?.initialDir === 'string' && req.body.initialDir.trim()
        ? path.resolve(req.body.initialDir.trim())
        : undefined;
    const picked = await pickFolder(initial);
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
    await rememberWorkspace(service.home(), resolved.root);
    return res.json({ workspaceRoot: resolved.root });
  }));

  router.get(API_ROUTES['threads.list'].path, asyncRoute(async (req: Request, res: Response) => {
    const store = await service.threads();
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

  router.post(API_ROUTES['threads.create'].path, asyncRoute(async (req: Request, res: Response) => {
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
      if (!(await workspaceAllowed(service, resolved.root, isTokenClient(res)))) return res.status(403).json({ error: WORKSPACE_NOT_PICKED });
      workspaceRoot = resolved.root;
    }
    const store = await service.threads();
    const thread = await store.createThread(model, title, {
      kind,
      workspaceRoot,
    });
    return res.status(201).json(thread);
  }));

  router.get(API_ROUTES['threads.get'].path, asyncRoute(async (req: Request, res: Response) => {
    const store = await service.threads();
    const thread = store.getThread(req.params.id);
    if (!thread) return res.status(404).json({ error: 'Thread not found' });
    const profile = thread.parentThreadId
      ? store.subagentProfile(req.params.id)
      : undefined;
    const detail: ThreadDetail = {
      ...thread,
      ...(profile ? { subagentProfile: profile } : {}),
      running: Boolean(service.runs.activeRun(req.params.id)),
    };
    return res.json(detail);
  }));

  router.patch(API_ROUTES['threads.update'].path, asyncRoute(async (req: Request, res: Response) => {
    const store = await service.threads();
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
      if (!(await workspaceAllowed(service, resolved.root, isTokenClient(res)))) return res.status(403).json({ error: WORKSPACE_NOT_PICKED });
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

  router.delete(API_ROUTES['threads.delete'].path, asyncRoute(async (req: Request, res: Response) => {
    const store = await service.threads();
    const root = store.getThread(req.params.id)?.workspaceRoot;
    const ok = await store.deleteThread(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Thread not found' });
    service.learning.cancel(req.params.id);
    // The folder's snapshots go with its last thread.
    if (root && !store.listThreads({ includeSubagents: true }).some((thread) => thread.workspaceRoot === root)) {
      void forgetCheckpoints(service.home(), root);
    }
    return res.json({ ok: true });
  }));

  router.get(API_ROUTES['threads.ledger'].path, asyncRoute(async (req: Request, res: Response) => {
    const store = await service.threads();
    const thread = store.getThread(req.params.id);
    if (!thread) return res.status(404).json({ error: 'Thread not found' });
    const messages = await store.toUiMessages(req.params.id);
    const envelopes = await store.readLedger(req.params.id, 0);
    const lastSeq = envelopes.at(-1)?.seq ?? 0;
    const lastUserSeq = store.lastUserSeq(envelopes);
    const snapshot = await store.readSnapshot(req.params.id);
    const plan = await store.readPlan(req.params.id);
    const lastRun = await readSettledLastRun(service, store, req.params.id);
    const activeRun = service.runs.activeRun(req.params.id);
    const queued = await store.readQueued(req.params.id);
    const ledger: LedgerResponse = {
      messages,
      lastSeq,
      ...(lastUserSeq !== undefined ? { lastUserSeq } : {}),
      snapshot,
      plan,
      ...(lastRun ? { lastRun } : {}),
      ...(activeRun ? { activeRun } : {}),
      ...(queued ? { queued } : {}),
      ...(isQueueStarting(req.params.id) ? { queueStarting: true as const } : {}),
    };
    return res.json(ledger);
  }));

  /** PUT /threads/:id/queue <run request with a message> — sent when the run ends (replaces one queued). */
  router.put(API_ROUTES['threads.queue'].path, asyncRoute(async (req: Request, res: Response) => {
    const request = parseQueuedRunRequest(req.body);
    if (typeof request === 'string') return res.status(400).json({ error: request });
    const result = await queueMessage(service, req.params.id, request);
    if (!result.ok) return res.status(result.reason === 'not_found' ? 404 : 400).json({ error: result.error });
    return res.json({ queued: result.queued });
  }));

  /** DELETE /threads/:id/queue — take the queued message back (into the composer). */
  router.delete(API_ROUTES['threads.takeQueued'].path, asyncRoute(async (req: Request, res: Response) => {
    return res.json({ queued: await takeQueued(service, req.params.id) });
  }));

  /** POST /threads/:id/queue/send { posture? } — stop the run going and send the queued message. */
  router.post(API_ROUTES['threads.sendQueued'].path, asyncRoute(async (req: Request, res: Response) => {
    const raw = (req.body as { posture?: unknown } | undefined)?.posture;
    const sent = await sendQueuedNow(service, req.params.id, raw === undefined ? undefined : normalizeRunPosture(raw));
    if (!sent) return res.status(404).json({ error: 'Nothing is queued on this thread' });
    return res.json({ ok: true });
  }));


  /** GET /threads/:id/changes?runIds=a,b — what those runs changed in the folder. */
  router.get(API_ROUTES['threads.changes'].path, asyncRoute(async (req: Request, res: Response) => {
    const store = await service.threads();
    const thread = store.getThread(req.params.id);
    if (!thread) return res.status(404).json({ error: 'Thread not found' });
    const runIds = await threadRunIds(service, req.params.id, req.query.runIds);
    if (!thread.workspaceRoot || runIds.length === 0) {
      return res.json({ available: false, files: [], notCovered: CHECKPOINT_NOT_COVERED } satisfies RunChanges);
    }
    return res.json(await runChanges({ agentHome: service.home(), root: thread.workspaceRoot, runIds }));
  }));

  /** GET /threads/:id/changes/diff?runIds=a,b&path=src/x.ts — one file's diff across those runs. */
  router.get(API_ROUTES['threads.changeDiff'].path, asyncRoute(async (req: Request, res: Response) => {
    const store = await service.threads();
    const thread = store.getThread(req.params.id);
    if (!thread?.workspaceRoot) return res.status(404).json({ error: 'Thread not found' });
    const file = typeof req.query.path === 'string' ? req.query.path : '';
    const runIds = await threadRunIds(service, req.params.id, req.query.runIds);
    if (!file || runIds.length === 0) return res.status(400).json({ error: 'runIds and path are required' });
    const diff = await runFileDiff({ agentHome: service.home(), root: thread.workspaceRoot, runIds, file });
    if (!diff) return res.status(404).json({ error: 'No snapshot exists for these runs' });
    return res.json(diff);
  }));

  /** POST /threads/:id/changes/undo { runIds } — put back what those runs changed. */
  router.post(API_ROUTES['threads.undoChanges'].path, asyncRoute(async (req: Request, res: Response) => {
    const store = await service.threads();
    const thread = store.getThread(req.params.id);
    if (!thread?.workspaceRoot) return res.status(404).json({ error: 'Thread not found' });
    if (service.runs.activeRun(req.params.id)) {
      return res.status(409).json({ error: 'Stop the running reply before undoing file changes.' });
    }
    const runIds = await threadRunIds(service, req.params.id, (req.body as { runIds?: unknown } | undefined)?.runIds);
    if (runIds.length === 0) return res.status(400).json({ error: 'runIds is required' });
    try {
      const result: RevertResult = await revertRuns({ agentHome: service.home(), root: thread.workspaceRoot, runIds });
      return res.json(result);
    } catch (error) {
      return res.status(409).json({ error: error instanceof Error ? error.message : String(error) });
    }
  }));

  return router;
}
