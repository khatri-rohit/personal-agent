/**
 * Boots the real HTTP app (`createApp`) on a throwaway AGENT_HOME, with no
 * network: these tests pin today's API behaviour so the migration onto
 * agent-service (docs/plans/one-binary-host-plan.md, stage 0) can prove it
 * changed nothing.
 *
 * - AGENT_HOME, HOME and USERPROFILE point at temp dirs: no test reads or
 *   writes the owner's real home or user skills.
 * - `fetch` is replaced by one that throws, so any call to a model, the
 *   Ollama balance, System 1 or Speaches fails loudly instead of leaving the
 *   machine. `localFetch` (the real one) is kept for talking to the app's
 *   own loopback server in streaming tests.
 * - System 1 is off, capacity is off (no OLLAMA_API_KEY), logs are silent.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { createAgentService, loadConfig, type AgentService } from '@agent/agent-service';
import type { Express } from 'express';
import { vi } from 'vitest';

export const localFetch: typeof fetch = globalThis.fetch.bind(globalThis);

export type ContractApp = {
  app: Express;
  service: AgentService;
  home: string;
  token: string;
  /** Headers a local process (CLI, eval runner) sends. */
  auth: { Authorization: string };
  close: () => Promise<void>;
};

export async function bootContractApp(env: Record<string, string> = {}): Promise<ContractApp> {
  const home = await mkdtemp(path.join(os.tmpdir(), 'agent-contract-home-'));
  const userHome = await mkdtemp(path.join(os.tmpdir(), 'agent-contract-user-'));
  const fixed: Record<string, string> = {
    AGENT_HOME: home,
    HOME: userHome,
    USERPROFILE: userHome,
    LOG_LEVEL: 'silent',
    SYSTEMONE_MODE: 'off',
    OLLAMA_API_KEY: '',
    OLLAMA_BASE_URL: 'http://127.0.0.1:9/v1',
    OLLAMA_LOCAL_BASE_URL: 'http://127.0.0.1:9/v1',
    AGENT_LEARNING_IDLE_MS: String(60 * 60_000),
    AGENT_FLAGS: '',
    AGENT_MODEL_STRONG: '',
    AGENT_MODEL_FAST: '',
    AGENT_WORKSPACE_ROOTS: '',
    CORS_ORIGIN: '',
    AGENT_ALLOWED_HOSTS: '',
    AGENT_RECORD_MODEL_CALLS: '',
    TAVILY_API_KEY: '',
    FIRECRAWL_API_KEY: '',
    SPEACHES_BASE_URL: '',
    VOICE_STT_PROVIDER: '',
    VOICE_TTS_PROVIDER: '',
    ...env,
  };
  for (const [key, value] of Object.entries(fixed)) vi.stubEnv(key, value);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      throw new Error(`network is disabled in contract tests: ${String(input)}`);
    }),
  );

  const { createApp } = await import('../app.js');
  const { createLogger } = await import('../platform/logger.js');
  // As main.ts does: the config is read once, after the env above is in place.
  const service = createAgentService({ config: loadConfig(process.env, os.homedir()) });
  const app = createApp(service, createLogger('contract'));
  const token = (await readFile(path.join(home, 'api-token'), 'utf8')).trim();

  return {
    app,
    service,
    home,
    token,
    auth: { Authorization: `Bearer ${token}` },
    close: async () => {
      (await service.threads()).close();
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      await rm(home, { recursive: true, force: true }).catch(() => undefined);
      await rm(userHome, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

/** Listens on a loopback port, for tests that stream (SSE) while posting. */
export async function listen(app: Express): Promise<{ base: string; server: Server }> {
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, server };
}

/** Parses an SSE body into its `data:` events (comments and `event: done` are kept as markers). */
export function parseSse(text: string): Array<{ event?: string; data: unknown }> {
  const out: Array<{ event?: string; data: unknown }> = [];
  for (const block of text.split('\n\n')) {
    const lines = block.split('\n').filter((line) => line && !line.startsWith(':'));
    if (lines.length === 0) continue;
    const event = lines.find((line) => line.startsWith('event: '))?.slice(7);
    const data = lines.find((line) => line.startsWith('data: '))?.slice(6);
    out.push({ ...(event ? { event } : {}), data: data ? JSON.parse(data) : null });
  }
  return out;
}
