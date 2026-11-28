import type {
  LedgerEnvelope,
  MemoryTarget,
  ModeConfig,
  OllamaEndpoint,
  Thread,
  ThreadLastRun,
  ThreadPlan,
} from '@agent/agent-models';
import {
  isWorkspaceKind,
  modeForKind,
  normalizeRunPosture,
  normalizeThreadKind,
  type ContextWindowMode,
  type HarnessFlags,
  type RunPosture,
} from '@agent/agent-models';
import {
  assembleContext,
  createMemoryTool,
  createPlanTools,
  createReadThreadTool,
  createRunToolset,
  createSessionSearchTool,
  loadWorkspaceRules,
  prepareCarriedRecord,
  getSkill,
  type ThreadReadSource,
  type ToolRegistry,
} from '@agent/agent-core';

import { resolveContextBudget } from '../models/model-runtime';
import type { ServiceCore } from '../service';
import type { ThreadStore } from '../threads/thread-store';

export function endpointFromLocal(local: boolean | undefined): OllamaEndpoint {
  return local === true ? 'local' : 'cloud';
}

/**
 * What `read_thread` reads: a thread of this home by id, with its ledger.
 * Any thread the user can open is readable (the user attached it, or
 * session_search found it); null when the id names none.
 */
async function readThreadSource(
  service: Pick<ServiceCore, 'runs'>,
  store: ThreadStore,
  threadId: string,
): Promise<ThreadReadSource | null> {
  const thread = store.getThread(threadId);
  if (!thread) return null;
  return {
    title: thread.title || 'Untitled thread',
    sourceLabel: isWorkspaceKind(thread.kind) ? (thread.workspaceRoot ?? 'Workspace') : 'Home',
    running: service.runs.activeRun(threadId) !== undefined,
    envelopes: await store.readLedger(threadId, 0),
  };
}

export type MemoryUpdatedPayload = {
  opId: string;
  target: MemoryTarget;
  action: 'add' | 'patch' | 'remove';
};

export type PlanUpdatedPayload = {
  plan: ThreadPlan;
};

export function lastUserEnvelope(
  envelopes: LedgerEnvelope[],
): LedgerEnvelope | undefined {
  for (let i = envelopes.length - 1; i >= 0; i--) {
    if (envelopes[i].record.role === 'user') return envelopes[i];
  }
  return undefined;
}

function skillNameList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const names = value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
  return names;
}

export function resolveRequestedSkills(
  raw: unknown,
  stored?: string[],
): string[] {
  const names =
    skillNameList(
      raw && typeof raw === 'object'
        ? (raw as { requested?: unknown }).requested
        : undefined,
    ) ?? stored;
  if (!names) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    const skill = getSkill(name);
    if (!skill) continue;
    const key = skill.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(skill.name);
  }
  return out;
}

export async function prepareRun(service: Pick<ServiceCore, 'config' | 'memory' | 'threads' | 'runs'>, input: {
  threadId: string;
  thread?: Thread;
  webSearch?: boolean;
  posture?: RunPosture;
  lastUserSeq: number;
  envelopes: LedgerEnvelope[];
  model: string;
  endpoint?: OllamaEndpoint;
  /** Overrides the thread's stored mode (estimate previews a change). */
  contextWindowMode?: ContextWindowMode;
  onMemoryUpdated?: (payload: MemoryUpdatedPayload) => void;
  onPlanUpdated?: (payload: PlanUpdatedPayload) => void;
}): Promise<{
  tools: ToolRegistry;
  messages: ReturnType<typeof assembleContext>['messages'];
  report: ReturnType<typeof assembleContext>['report'];
  mode: ModeConfig;
  posture: RunPosture;
  /** Resolved once here; the loop must run with the same switches the prompt was built with. */
  flags: HarnessFlags;
}> {
  const { flags } = service.config;
  const memory = service.memory();
  const kind = normalizeThreadKind(input.thread?.kind);
  const mode = modeForKind(kind);
  const workspace = isWorkspaceKind(kind);
  const workspaceRoot = workspace ? input.thread?.workspaceRoot : undefined;
  const files = await memory.read(workspaceRoot);
  const posture = workspace
    ? normalizeRunPosture(input.posture)
    : ('agent' as const);
  if (workspace && workspaceRoot) {
    const rules = await loadWorkspaceRules(workspaceRoot);
    files.agentsMd = rules.agentsMd;
    files.project = rules.project;
  }
  const store = await service.threads();
  const plan =
    input.threadId === 'draft' ? null : await store.readPlan(input.threadId);
  const planTools =
    input.threadId === 'draft'
      ? []
      : createPlanTools({
          read: () => store.readPlan(input.threadId),
          write: async (next) => {
            const saved = await store.writePlan(input.threadId, next);
            input.onPlanUpdated?.({ plan: saved });
            return saved;
          },
        });

  const tools = createRunToolset({
    mode,
    posture,
    webSearch: input.webSearch,
    siblingBriefs: flags.siblingBriefs,
    hostTools: [
      ...planTools,
      createSessionSearchTool(async (query, limit) =>
        store.searchMessages(query, { excludeThreadId: input.threadId, limit }),
      ),
      createReadThreadTool({
        read: (threadId) => readThreadSource(service, store, threadId),
        currentThreadId: input.threadId,
      }),
      createMemoryTool({
        read: () => memory.read(workspaceRoot),
        apply: async (op) => {
          const applied = await memory.apply(op, workspaceRoot);
          input.onMemoryUpdated?.({
            opId: applied.id,
            target: applied.target,
            action: applied.action,
          });
          return applied;
        },
        stage: (op) => memory.stage(op, workspaceRoot),
        source: () => ({
          threadId: input.threadId,
          seq: input.lastUserSeq,
        }),
      }),
    ],
  });

  const window = await resolveContextBudget(
    input.model,
    input.endpoint ?? 'cloud',
    input.contextWindowMode ?? input.thread?.contextWindowMode,
  );

  const snapshot =
    input.threadId === 'draft'
      ? null
      : await store.readSnapshot(input.threadId);

  // Findings earlier runs recorded: carried in the stable
  // prefix, bounded like the card's record, the rest behind a blob sha.
  const carriedRecord =
    input.threadId === 'draft'
      ? null
      : await prepareCarriedRecord({
          records: await store.readTaskRecords(input.threadId),
          envelopes: input.envelopes,
          tokens: window.budget.recordCardTokens,
          putBlob: (text) => store.putBlob(input.threadId, text),
        });

  const lastRun =
    input.threadId === 'draft' ? null : await readSettledLastRun(service, store, input.threadId);
  const { messages, report } = assembleContext(
    {
      tools,
      memory: files,
      snapshot,
      envelopes: input.envelopes,
      mode: mode.name,
      posture,
      ...(plan ? { plan } : {}),
      ...(lastRun ? { lastRun } : {}),
      ...(carriedRecord ? { carriedRecord } : {}),
      flags,
    },
    window.budget,
  );

  return {
    tools,
    messages,
    report: { ...report, windowSource: window.source },
    mode,
    posture,
    flags,
  };
}/**
 * The thread's last settled run. While a run is live, its lastRun is only the
 * "interrupted" marker written at start, so it is not reported.
 */
export async function readSettledLastRun(
  service: Pick<ServiceCore, 'runs'>,
  store: ThreadStore,
  threadId: string,
): Promise<ThreadLastRun | null> {
  const lastRun = await store.readLastRun(threadId);
  return lastRun && !service.runs.isActive(lastRun.runId) ? lastRun : null;
}


