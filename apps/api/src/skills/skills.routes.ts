import { Router, type Request, type Response } from 'express';
import {
  extraSkillRoots,
  listSkillCatalogs,
  runWithSkillRoots,
} from '@agent/agent-core';

import { getAgentHome, getThreadStore } from '../platform/instances';
import { asyncRoute } from '../platform/http-errors';
import {
  SkillError,
  createUserSkill,
  deleteUserSkill,
  readSkillDocument,
} from './user-skills';

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

async function overlayForThread(threadId: unknown) {
  const id = typeof threadId === 'string' ? threadId.trim() : '';
  if (!id) return [];
  const store = await getThreadStore();
  return extraSkillRoots(store.getThread(id)?.workspaceRoot);
}

router.get(
  '/skills',
  asyncRoute(async (req: Request, res: Response) => {
    getAgentHome();
    const extra = await overlayForThread(req.query.threadId);
    res.json(runWithSkillRoots(extra, () => listSkillCatalogs()));
  }),
);

router.post(
  '/skills/create',
  asyncRoute(async (req: Request, res: Response) => {
    try {
      await createUserSkill({
        agentHome: getAgentHome(),
        name: String(req.body?.name ?? ''),
        content: String(req.body?.content ?? ''),
      });
      res.json(listSkillCatalogs());
    } catch (error) {
      fail(res, error);
    }
  }),
);

router.get(
  '/skills/:folder',
  asyncRoute(async (req: Request, res: Response) => {
    try {
      getAgentHome();
      const extra = await overlayForThread(req.query.threadId);
      res.json(
        await runWithSkillRoots(extra, () =>
          readSkillDocument({
            folder: String(req.params.folder ?? ''),
          }),
        ),
      );
    } catch (error) {
      fail(res, error);
    }
  }),
);

router.delete(
  '/skills/:folder',
  asyncRoute(async (req: Request, res: Response) => {
    try {
      await deleteUserSkill({
        agentHome: getAgentHome(),
        folderName: String(req.params.folder ?? ''),
      });
      res.json(listSkillCatalogs());
    } catch (error) {
      fail(res, error);
    }
  }),
);

export { router as skillsRouter };
