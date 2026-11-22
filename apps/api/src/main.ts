import express from 'express';
import cors from 'cors';

import { memoryRouter } from './memory/memory.routes';
import { warnRoleModelsWithoutTools } from './models/model-runtime';
import { modelsRouter } from './models/models.routes';
import { accessGuard, accessPolicyFromEnv, API_TOKEN_FILE, isAllowedOrigin, loadOrCreateApiToken } from './platform/access';
import { errorHandler } from './platform/http-errors';
import { getAgentHome } from './platform/instances';
import { createLogger, createHttpLogger } from './platform/logger';
import { runsRouter } from './runs/runs.routes';
import { initSystem1 } from './runs/system1-runtime';
import { skillsRouter } from './skills/skills.routes';
import { threadsRouter } from './threads/threads.routes';
import { voiceProviders, voiceRouter } from './voice/voice.routes';

const host = process.env.HOST ?? 'localhost';
const port = process.env.PORT ? Number(process.env.PORT) : 3333;

const logger = createLogger('api');

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

app.listen(port, host, () => {
  logger.info(
    { host, port, voice: voiceProviders, tokenFile: `${getAgentHome()}/${API_TOKEN_FILE}` },
    'api ready',
  );
  // Logs the System 1 setup and warms the scorer; never blocks or throws.
  initSystem1();
  void warnRoleModelsWithoutTools();
});
