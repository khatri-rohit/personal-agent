import { existsSync } from 'node:fs';
import os from 'node:os';
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

import { resolveAgentHome } from './agent-home.js';
import { MemoryStore } from '../memory/memory-store.js';
import { openThreadStore, type ThreadStore } from '../threads/thread-store.js';

function home(): string {
  const resolved = resolveAgentHome({
    env: process.env,
    homedir: os.homedir(),
  });
  if (process.env.AGENT_HOME) return resolved;
  const legacy = path.join(os.homedir(), '.local', 'agent');
  if (!existsSync(resolved) && existsSync(legacy)) return legacy;
  return resolved;
}

let storePromise: Promise<ThreadStore> | undefined;
let agentsConfigured = false;
let memoryStore: MemoryStore | undefined;

export function getAgentHome(): string {
  const dir = home();
  // Lowest to highest: builtin, ~/.agents/skills, $AGENT_HOME/skills.
  // A bound workspace's .agents/skills is overlaid per run and only adds
  // names (core `skills.ts`). No-op when unchanged.
  configureSkillRoots([
    { scope: 'builtin', id: 'builtin', path: resolveSkillsRoot() },
    ...standardUserSkillRoots(dir, os.homedir()),
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
}

export function getThreadStore(): Promise<ThreadStore> {
  if (!storePromise) {
    storePromise = openThreadStore(getAgentHome()).then((store) => {
      // Threads from before the search index: indexed once, off the request path.
      store.backfillSearchIndex().catch((error: unknown) => {
        console.warn(
          '[search] backfill failed:',
          error instanceof Error ? error.message : error,
        );
      });
      return store;
    });
  }
  return storePromise;
}

export function getMemoryStore(): MemoryStore {
  if (!memoryStore) {
    memoryStore = new MemoryStore(getAgentHome());
  }
  return memoryStore;
}

/** In-memory runs for this process: SSE replay, choices, one active run per thread. */
export const runManager = new RunManager();
