import { createAgentClient } from '@agent/agent-client';

/**
 * The agent host. NEXT_PUBLIC_API_BASE (inlined at build time) until the UI
 * is served from the host's own origin (docs/plans/one-binary-host-plan.md,
 * stage 4); it is the only place the web app names it.
 */
export const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:3333';

/** Every HTTP call of the web app goes through this client (agent-client). */
export const api = createAgentClient({ baseUrl: API_BASE });
