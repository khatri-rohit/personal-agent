import { createAgentClient } from '@agent/agent-client';

/**
 * The agent host. The UI is served from the host's own origin, so the base is
 * `''` (same origin); in dev the Vite server proxies `/api` to the host. This
 * is the only place the web app names it.
 */
export const API_BASE = '';

/** Every HTTP call of the web app goes through this client (agent-client). */
export const api = createAgentClient({ baseUrl: API_BASE });
