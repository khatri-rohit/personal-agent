import { existsSync } from 'node:fs';
import path from 'node:path';

import {
  configureSkillRoots,
  configureSubagentRoot,
  listSkillCatalogs,
  listTools,
  resolveSkillsRoot,
  RunManager,
  skillLintWarnings,
  standardUserSkillRoots,
  subagentProfileWarnings,
} from '@agent/agent-core';

import { createLearningLoop, type LearningLoop } from './memory/learning-loop';
import { MemoryStore } from './memory/memory-store';
import { resolveAgentHome } from './platform/agent-home';
import { system1SettingsFrom, type System1Settings } from './runs/system1-runtime';
import { openThreadStore, type ThreadStore } from './threads/thread-store';

/**
 * The host settings the service reads, by name. `loadConfig` copies exactly
 * these from the environment once; nothing in the service reads
 * `process.env` for config after that (ADR-0003 §4.1). The engine
 * (agent-core) still reads its own keys, so the caller loads `.env` first.
 */
export const HOST_ENV_KEYS = [
  'AGENT_HOME',
  'AGENT_FLAGS',
  'AGENT_LEARNING_IDLE_MS',
  'AGENT_MODEL_FAST',
  'AGENT_MODEL_STRONG',
  'AGENT_MODEL_SUMMARY',
  'TITLE_MODEL',
  'AGENT_RECORD_MODEL_CALLS',
  'AGENT_WORKSPACE_ROOTS',
  'OLLAMA_API_KEY',
  'OLLAMA_SYSTEMONE_URL',
  'SYSTEMONE_MODE',
  'SYSTEMONE_MODEL',
  'SYSTEMONE_TIMEOUT_MS',
  'SYSTEMONE_WITH_LOCAL',
] as const;
export type HostEnvKey = (typeof HOST_ENV_KEYS)[number];
/** Raw values, parsed where they are used exactly as before. */
export type HostEnv = Readonly<Partial<Record<HostEnvKey, string>>>;

export type AgentConfig = Readonly<{
  env: HostEnv;
  /** The user's home directory (os.homedir() in production). */
  homedir: string;
}>;

/** A frozen snapshot of the host keys in `env`. */
export function loadConfig(env: Record<string, string | undefined>, homedir: string): AgentConfig {
  const picked: Partial<Record<HostEnvKey, string>> = {};
  for (const key of HOST_ENV_KEYS) {
    const value = env[key];
    if (value !== undefined) picked[key] = value;
  }
  return Object.freeze({ env: Object.freeze(picked), homedir });
}

/**
 * The host: the one owner of the state that derives from an agent home and
 * its config. Transports (HTTP routes, the CLI later) hold this object and
 * nothing else. One per process (ADR-0003 §4.2): the engine keeps
 * process-wide caches (skill roots, sub-agent profiles, model clients).
 */
export interface AgentService {
  readonly config: AgentConfig;
  /** In-memory runs: SSE replay, choices, one active run per thread. */
  readonly runs: RunManager;
  /** System 1 wiring from config; null when disabled. */
  readonly system1: System1Settings | null;
  readonly learning: LearningLoop;
  /**
   * The agent home. Every call also re-applies the skill roots (builtin,
   * ~/.agents/skills, $AGENT_HOME/skills): core's contract is that hosts
   * call it on every request, and it is a no-op when nothing changed.
   */
  home(): string;
  threads(): Promise<ThreadStore>;
  memory(): MemoryStore;
  /** True once `close` began: new runs are refused. */
  closing(): boolean;
  /**
   * Graceful stop: refuse new runs, cancel the ones going, wait up to
   * `timeoutMs` for them to write their last rows. True if all settled.
   */
  close(timeoutMs: number): Promise<boolean>;
}

let created = false;

/** Resolved once: AGENT_HOME, else ~/.local/personal-assistant, else the legacy ~/.local/agent if only that exists. */
function resolveHome(config: AgentConfig): string {
  const resolved = resolveAgentHome({ env: config.env, homedir: config.homedir });
  if (config.env.AGENT_HOME) return resolved;
  const legacy = path.join(config.homedir, '.local', 'agent');
  if (!existsSync(resolved) && existsSync(legacy)) return legacy;
  return resolved;
}

export function createAgentService(options: { config: AgentConfig }): AgentService {
  if (created) {
    throw new Error('An AgentService already exists in this process; the engine allows one (ADR-0003 §4.2).');
  }
  created = true;
  const { config } = options;
  const dir = resolveHome(config);
  const runs = new RunManager();
  let agentsConfigured = false;
  let storePromise: Promise<ThreadStore> | undefined;
  let memoryStore: MemoryStore | undefined;

  const home = (): string => {
    // Lowest to highest: builtin, ~/.agents/skills, $AGENT_HOME/skills.
    // A bound workspace's .agents/skills is overlaid per run and only adds
    // names (core `skills.ts`). No-op when unchanged.
    configureSkillRoots([
      { scope: 'builtin', id: 'builtin', path: resolveSkillsRoot() },
      ...standardUserSkillRoots(dir, config.homedir),
    ]);
    if (!agentsConfigured) {
      agentsConfigured = true;
      // User sub-agents: $AGENT_HOME/agents/<name>.md. Bad files are skipped, not fatal.
      configureSubagentRoot(
        path.join(dir, 'agents'),
        listTools().map((tool) => tool.definition.function.name),
      );
      for (const warning of subagentProfileWarnings()) {
        console.warn(`[agents] skipped ${warning}`);
      }
      // Once at boot: packs that will not load, and large packs that lose
      // most of their rules when evicted (no `## Core rules`).
      const catalogs = listSkillCatalogs();
      for (const entry of [...catalogs.builtin, ...catalogs.user]) {
        if (entry.issue === 'invalid') {
          console.warn(`[skills] skipped ${entry.root}/${entry.folder}: ${entry.reason ?? 'invalid'}`);
        }
      }
      for (const warning of skillLintWarnings()) {
        console.warn(`[skills] ${warning}`);
      }
    }
    return dir;
  };

  const threads = (): Promise<ThreadStore> => {
    if (!storePromise) {
      storePromise = openThreadStore(home()).then((store) => {
        // Threads from before the search index: indexed once, off the request path.
        store.backfillSearchIndex().catch((error: unknown) => {
          console.warn('[search] backfill failed:', error instanceof Error ? error.message : error);
        });
        return store;
      });
    }
    return storePromise;
  };

  const memory = (): MemoryStore => {
    if (!memoryStore) memoryStore = new MemoryStore(home());
    return memoryStore;
  };

  let stopping = false;
  const closing = (): boolean => stopping;
  const close = (timeoutMs: number): Promise<boolean> => {
    stopping = true;
    return runs.drain(timeoutMs);
  };

  const base: ServiceCore = { config, runs, system1: system1SettingsFrom(config.env), home, threads, memory, closing, close };
  return { ...base, learning: createLearningLoop(base) };
}

/** The service without the parts built from it (what the learning loop needs). */
export type ServiceCore = Omit<AgentService, 'learning'>;
