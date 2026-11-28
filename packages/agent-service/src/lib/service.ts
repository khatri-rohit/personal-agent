import { existsSync } from 'node:fs';
import path from 'node:path';

import {
  configureSkillRoots,
  configureSubagentRoot,
  listSkillCatalogs,
  listTools,
  resolveSkillsRoot,
  RunManager,
  standardUserSkillRoots,
  subagentProfileWarnings,
} from '@agent/agent-core';

import type { AgentConfig } from './config';
import { createLearningLoop, type LearningLoop } from './memory/learning-loop';
import { MemoryStore } from './memory/memory-store';
import { openThreadStore, type ThreadStore } from './threads/thread-store';

/**
 * The host: the one owner of the state that derives from an agent home and
 * its config. Transports (HTTP routes, the CLI later) hold this object and
 * nothing else. One per process: the engine keeps
 * process-wide caches (skill roots, sub-agent profiles, model clients).
 */
export interface AgentService {
  readonly config: AgentConfig;
  /** In-memory runs: SSE replay, choices, one active run per thread. */
  readonly runs: RunManager;
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
  if (config.agentHome) return config.agentHome;
  const resolved = path.join(config.homedir, '.local', 'personal-assistant');
  const legacy = path.join(config.homedir, '.local', 'agent');
  if (!existsSync(resolved) && existsSync(legacy)) return legacy;
  return resolved;
}

export function createAgentService(options: { config: AgentConfig }): AgentService {
  if (created) {
    throw new Error('An AgentService already exists in this process; the engine allows one.');
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
      // Once at boot: packs that will not load, with the reason.
      const catalogs = listSkillCatalogs();
      for (const entry of [...catalogs.builtin, ...catalogs.user]) {
        if (entry.issue === 'invalid') {
          console.warn(`[skills] skipped ${entry.root}/${entry.folder}: ${entry.reason ?? 'invalid'}`);
        }
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

  const base: ServiceCore = { config, runs, home, threads, memory, closing, close };
  return { ...base, learning: createLearningLoop(base) };
}

/** The service without the parts built from it (what the learning loop needs). */
export type ServiceCore = Omit<AgentService, 'learning'>;
