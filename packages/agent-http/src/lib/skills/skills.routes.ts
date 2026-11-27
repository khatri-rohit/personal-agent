import { Router, type Request, type Response } from 'express';
import { API_ROUTES } from '@agent/agent-models';
import type { AgentService } from '@agent/agent-service';
import {
  extraSkillRoots,
  listSkillCatalogs,
  runWithSkillRoots,
  type SkillRoot,
} from '@agent/agent-core';


import { asyncRoute } from '../platform/http-errors';
import { SkillError, createUserSkill, deleteUserSkill, readSkillDocument } from '@agent/agent-service';

export function skillsRouter(service: AgentService): Router {
  const router = Router();

  function fail(res: Response, error: unknown): void {
    if (error instanceof SkillError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Skill request failed',
    });
  }

  /**
   * `?threadId=` binds the request to that thread's workspace, so every
   * response (list, read, and the catalog returned after create / delete)
   * shows the same roots a run in that thread would see.
   */
  async function overlayFor(req: Request): Promise<SkillRoot[]> {
    const raw = req.query.threadId;
    const id = typeof raw === 'string' ? raw.trim() : '';
    if (!id) return [];
    const store = await service.threads();
    return extraSkillRoots(store.getThread(id)?.workspaceRoot);
  }

  router.get(
    API_ROUTES['skills.list'].path,
    asyncRoute(async (req: Request, res: Response) => {
      service.home();
      const extra = await overlayFor(req);
      res.json(runWithSkillRoots(extra, () => listSkillCatalogs()));
    }),
  );

  router.post(
    API_ROUTES['skills.create'].path,
    asyncRoute(async (req: Request, res: Response) => {
      try {
        const agentHome = service.home();
        const extra = await overlayFor(req);
        await createUserSkill({
          agentHome,
          name: String(req.body?.name ?? ''),
          content: String(req.body?.content ?? ''),
        });
        res.json(runWithSkillRoots(extra, () => listSkillCatalogs()));
      } catch (error) {
        fail(res, error);
      }
    }),
  );

  router.get(
    API_ROUTES['skills.get'].path,
    asyncRoute(async (req: Request, res: Response) => {
      try {
        service.home();
        const extra = await overlayFor(req);
        const root = typeof req.query.root === 'string' ? req.query.root : undefined;
        res.json(
          await runWithSkillRoots(extra, () =>
            readSkillDocument({
              folder: String(req.params.folder ?? ''),
              ...(root ? { root } : {}),
            }),
          ),
        );
      } catch (error) {
        fail(res, error);
      }
    }),
  );

  router.delete(
    API_ROUTES['skills.delete'].path,
    asyncRoute(async (req: Request, res: Response) => {
      try {
        const agentHome = service.home();
        const extra = await overlayFor(req);
        await runWithSkillRoots(extra, () =>
          deleteUserSkill({
            agentHome,
            folderName: String(req.params.folder ?? ''),
          }),
        );
        res.json(runWithSkillRoots(extra, () => listSkillCatalogs()));
      } catch (error) {
        fail(res, error);
      }
    }),
  );

  return router;
}
