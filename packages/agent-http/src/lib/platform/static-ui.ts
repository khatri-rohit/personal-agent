import { existsSync } from 'node:fs';
import path from 'node:path';

import express, { type NextFunction, type Request, type Response, type Router } from 'express';

/**
 * Serves the built chat UI (apps/web `dist`) on the API's own origin.
 * Hashed files under `assets/` never change, so they are
 * cached for good; the shell is revalidated on every load so a new build is
 * picked up. Any other GET outside `/api` gets the shell: the SPA router owns
 * those paths (`/`, `/chat/<id>`).
 */
export function staticUi(dir: string): Router {
  const shell = path.join(dir, 'index.html');
  const router = express.Router();

  router.use(
    express.static(dir, {
      index: false,
      setHeaders: (res, file) => {
        const hashed = path.relative(dir, file).split(path.sep)[0] === 'assets';
        res.setHeader('Cache-Control', hashed ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    }),
  );

  router.get(/^(?!\/api(\/|$)).*/, (_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(shell, (err) => {
      if (err) next(err);
    });
  });

  return router;
}

/** The UI folder to serve, or `null` (headless) when there is no built UI there. */
export function resolveUiDir(candidate: string | undefined): string | null {
  if (!candidate) return null;
  const dir = path.resolve(candidate);
  return existsSync(path.join(dir, 'index.html')) ? dir : null;
}
