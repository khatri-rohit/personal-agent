import express, { type Express } from 'express';
import { API_MOUNTS, API_ROUTES, PROTOCOL_VERSION } from '@agent/agent-models';

import { memoryRouter } from './memory/memory.routes';
import { modelsRouter } from './models/models.routes';
import { accessGuard, accessPolicyFromEnv, hostGuard, loadOrCreateApiToken } from './platform/access';
import { harnessVersion } from '@agent/agent-service';
import { errorHandler } from './platform/http-errors';
import type { AgentService } from '@agent/agent-service';
import type { Logger } from './platform/logger';
import { createHttpLogger } from './platform/logger';
import { staticUi } from './platform/static-ui';
import { runsRouter } from './runs/runs.routes';
import { skillsRouter } from './skills/skills.routes';
import { threadsRouter, type PickFolder } from './threads/threads.routes';
import { voiceRouter } from './voice/voice.routes';

export type AppOptions = {
  /** The built chat UI to serve on this origin; `null` or absent = headless (API only). */
  uiDir?: string | null;
  /** Admit a same-origin browser page without the token (off when bound beyond loopback). */
  browser?: boolean;
  /** The native folder dialog behind POST /workspace/pick (an OS port of the app). */
  pickFolder?: PickFolder;
};

/**
 * The HTTP app with every middleware and router, in the order the API has
 * always mounted them. `main.ts` only adds `listen` and start-up work, so
 * the contract tests drive exactly what users hit.
 */
export function createApp(service: AgentService, logger: Logger, options: AppOptions = {}): Express {
  const app = express();

  // Only this machine's own apps drive the API (platform/access.ts): a loopback
  // Host, and either this server's own page or the token in AGENT_HOME/api-token.
  const access = accessPolicyFromEnv(loadOrCreateApiToken(service.home()), process.env, {
    browser: options.browser ?? true,
  });
  app.use(hostGuard(access));
  app.use('/api', accessGuard(access));

  app.use(express.json({ limit: '25mb' }));

  // Request-scoped structured logging: stamps x-request-id, logs each request in/out.
  // SSE event streams and OPTIONS preflight are skipped (see createHttpLogger).
  app.use(createHttpLogger(logger));

  // What this process runs and where it writes: the eval runner checks both
  // before a suite (a stale API, or one on the wrong home, measures the wrong thing).
  app.get(`${API_MOUNTS.agent}${API_ROUTES.version.path}`, (_req, res, next) => {
    harnessVersion()
      .then((version) => res.json({ harnessVersion: version, agentHome: service.home(), protocolVersion: PROTOCOL_VERSION }))
      .catch(next);
  });

  // Agent endpoints (no two routers share a path, so order does not matter)
  app.use(
    API_MOUNTS.agent,
    skillsRouter(service),
    modelsRouter(service),
    threadsRouter(service, options.pickFolder),
    runsRouter(service),
    memoryRouter(service),
  );

  // Voice add-on (Speaches, not Ollama). The voice module decides which routes
  // exist; nothing on the run path depends on them.
  app.use(API_MOUNTS.voice, voiceRouter);

  // The chat UI on the same origin; any other GET outside /api gets its shell.
  if (options.uiDir) app.use(staticUi(options.uiDir));

  app.use(errorHandler);
  return app;
}
