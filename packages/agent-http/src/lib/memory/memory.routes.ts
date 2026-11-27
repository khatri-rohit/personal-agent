import { Router, type Request, type Response } from 'express';
import { API_ROUTES } from '@agent/agent-models';
import type { AgentService } from '@agent/agent-service';
import { DEFAULT_MEMORY_CAPS, isWorkspaceKind, revertedOpId } from '@agent/agent-models';

import { asyncRoute } from '../platform/http-errors';

export function memoryRouter(service: AgentService): Router {
  const router = Router();

  router.get(API_ROUTES['memory.get'].path, asyncRoute(async (req: Request, res: Response) => {
    const memory = service.memory();
    const workspaceRoot =
      typeof req.query.workspaceRoot === 'string' &&
      req.query.workspaceRoot.trim()
        ? req.query.workspaceRoot.trim()
        : undefined;
    const [files, ops] = await Promise.all([
      memory.read(workspaceRoot),
      memory.listOps(),
    ]);
    const reverted = new Set(ops.map(revertedOpId).filter(Boolean));
    // Reverts and the entries they undo both leave the list.
    const visible = ops.filter(
      (op) =>
        op.status === 'applied' && !revertedOpId(op) && !reverted.has(op.id),
    );
    return res.json({ files, ops: visible, caps: DEFAULT_MEMORY_CAPS });
  }));

  router.patch(API_ROUTES['memory.update'].path, asyncRoute(async (req: Request, res: Response) => {
    const user = typeof req.body?.user === 'string' ? req.body.user : undefined;
    if (user === undefined) {
      return res.status(400).json({ error: 'user is required' });
    }
    const threadId =
      typeof req.body?.threadId === 'string' && req.body.threadId.trim()
        ? req.body.threadId.trim()
        : 'settings';
    try {
      const op = await service.memory().writeUser(user, { threadId, seq: 0 });
      return res.json({ op });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return res.status(400).json({ error: msg });
    }
  }));

  router.post(API_ROUTES['memory.revert'].path, asyncRoute(async (req: Request, res: Response) => {
    const opId = typeof req.body?.opId === 'string' ? req.body.opId.trim() : '';
    if (!opId) return res.status(400).json({ error: 'opId is required' });
    try {
      const op = await service.memory().revert(opId);
      return res.json({ op });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return res.status(400).json({ error: msg });
    }
  }));

  /** Suggestions waiting for the user (learning loop, staged foreground writes). */
  router.get(API_ROUTES['memory.pending'].path, asyncRoute(async (_req: Request, res: Response) => {
    return res.json({ ops: await service.memory().listPending() });
  }));

  /** Approve or reject one pending suggestion. Notes go to the folder of the thread that proposed them. */
  router.post(API_ROUTES['memory.resolvePending'].path, asyncRoute(async (req: Request, res: Response) => {
    const decision = req.body?.decision;
    if (decision !== 'approve' && decision !== 'reject') {
      return res.status(400).json({ error: 'decision must be approve or reject' });
    }
    const memory = service.memory();
    const op = (await memory.listPending()).find((item) => item.id === req.params.opId);
    if (!op) return res.status(404).json({ error: 'Pending suggestion not found' });
    const thread = (await service.threads()).getThread(op.source.threadId);
    const workspaceRoot =
      op.target === 'notes' && thread && isWorkspaceKind(thread.kind)
        ? thread.workspaceRoot
        : undefined;
    try {
      const resolved = await memory.resolveStaged(op.id, decision, workspaceRoot);
      return res.json({ op: resolved });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return res.status(400).json({ error: msg });
    }
  }));

  return router;
}
