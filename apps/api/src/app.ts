import express, { type Express } from 'express';
import cors from 'cors';

import { memoryRouter } from './memory/memory.routes';
import { modelsRouter } from './models/models.routes';
import { accessGuard, accessPolicyFromEnv, isAllowedOrigin, loadOrCreateApiToken } from './platform/access';
import { harnessVersion } from '@agent/agent-service';
import { errorHandler } from './platform/http-errors';
import { getAgentHome } from '@agent/agent-service';
import type { Logger } from './platform/logger';
import { createHttpLogger } from './platform/logger';
import { runsRouter } from './runs/runs.routes';
import { skillsRouter } from './skills/skills.routes';
import { threadsRouter } from './threads/threads.routes';
import { voiceRouter } from './voice/voice.routes';

/**
 * The HTTP app with every middleware and router, in the order the API has
 * always mounted them. `main.ts` only adds `listen` and start-up work, so
 * the contract tests drive exactly what users hit.
 */
export function createApp(logger: Logger): Express {
  const app = express();

  // Only this machine's own apps drive the API (platform/access.ts): a loopback
  // Host, and either the web app's origin or the token in AGENT_HOME/api-token.
  const access = accessPolicyFromEnv(loadOrCreateApiToken(getAgentHome()));
  app.use(accessGuard(access));

  app.use(
    cors({
      // Reflects only origins the guard let in; never an arbitrary site.
      origin: (origin, callback) => callback(null, origin === undefined || isAllowedOrigin(origin, access)),
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: [
        'Content-Type',
        'Accept',
        'Origin',
        'X-Requested-With',
        'X-Voice-Context',
      ],
    }),
  );

  app.use(express.json({ limit: '25mb' }));

  // Request-scoped structured logging: stamps x-request-id, logs each request in/out.
  // SSE event streams and OPTIONS preflight are skipped (see createHttpLogger).
  app.use(createHttpLogger(logger));

  // What this process runs and where it writes: the eval runner checks both
  // before a suite (a stale API, or one on the wrong home, measures the wrong thing).
  app.get('/api/agent/version', (_req, res, next) => {
    harnessVersion()
      .then((version) => res.json({ harnessVersion: version, agentHome: getAgentHome() }))
      .catch(next);
  });

  // Agent endpoints (no two routers share a path, so order does not matter)
  app.use(
    '/api/agent',
    skillsRouter,
    modelsRouter,
    threadsRouter,
    runsRouter,
    memoryRouter,
  );

  // Voice add-on (Speaches, not Ollama). The voice module decides which routes
  // exist; nothing on the run path depends on them.
  app.use('/api/voice', voiceRouter);

  app.use(errorHandler);
  return app;
}
