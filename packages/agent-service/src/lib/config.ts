import path from 'node:path';

import {
  parseHarnessFlags,
  type HarnessFlags,
  type ModelSettingRole,
} from '@agent/agent-models';

import { system1SettingsFrom, type System1Settings } from './runs/system1-runtime';

/**
 * The host's settings, parsed once from the environment (ADR-0003 §4.1).
 * Nothing in the service reads `process.env` or raw strings for config after
 * this; each field is the typed value its consumer uses. The engine
 * (agent-core) still reads its own keys, so the caller loads `.env` first.
 */
export type AgentConfig = Readonly<{
  /** The user's home directory (os.homedir() in production). */
  homedir: string;
  /** AGENT_HOME as an absolute path; undefined = the default under `homedir`. */
  agentHome: string | undefined;
  /** AGENT_FLAGS. */
  flags: Readonly<HarnessFlags>;
  /** OLLAMA_API_KEY: the cloud account (capacity, balance, cloud role picks). */
  ollamaApiKey: string | undefined;
  /** AGENT_MODEL_FAST / _STRONG / _SUMMARY and TITLE_MODEL, trimmed; a missing role uses the run's model. */
  roleModels: Readonly<Partial<Record<ModelSettingRole, string>>>;
  /** AGENT_RECORD_MODEL_CALLS: record each model call's exact input and output unless "0". */
  recordModelCalls: boolean;
  /** AGENT_LEARNING_IDLE_MS: how long a thread stays quiet before its memory review. */
  learningIdleMs: number;
  /** AGENT_WORKSPACE_ROOTS: parent folders whose subfolders open without the picker. */
  workspaceRoots: readonly string[];
  /** OLLAMA_SYSTEMONE_URL and SYSTEMONE_*: null = System 1 off. */
  system1: System1Settings | null;
}>;

/** The env var behind each role model (also named in warnings). */
export const ROLE_MODEL_ENV: Readonly<Record<ModelSettingRole, string>> = {
  fast: 'AGENT_MODEL_FAST',
  strong: 'AGENT_MODEL_STRONG',
  summary: 'AGENT_MODEL_SUMMARY',
  title: 'TITLE_MODEL',
};

const DEFAULT_LEARNING_IDLE_MS = 10 * 60_000;

function text(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  return value ? value : undefined;
}

function positiveNumber(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Parse the host's keys out of `env` (the boundary: every later read is typed). */
export function loadConfig(env: Record<string, string | undefined>, homedir: string): AgentConfig {
  const roleModels: Partial<Record<ModelSettingRole, string>> = {};
  for (const [role, key] of Object.entries(ROLE_MODEL_ENV) as Array<[ModelSettingRole, string]>) {
    const model = text(env[key]);
    if (model) roleModels[role] = model;
  }
  const agentHome = env.AGENT_HOME;
  return Object.freeze({
    homedir,
    agentHome: agentHome ? path.resolve(agentHome) : undefined,
    flags: Object.freeze(parseHarnessFlags(env.AGENT_FLAGS)),
    ollamaApiKey: env.OLLAMA_API_KEY || undefined,
    roleModels: Object.freeze(roleModels),
    recordModelCalls: env.AGENT_RECORD_MODEL_CALLS !== '0',
    learningIdleMs: positiveNumber(env.AGENT_LEARNING_IDLE_MS, DEFAULT_LEARNING_IDLE_MS),
    workspaceRoots: Object.freeze(
      (env.AGENT_WORKSPACE_ROOTS ?? '').split(path.delimiter).map((item) => item.trim()).filter(Boolean),
    ),
    system1: system1SettingsFrom(env),
  });
}
