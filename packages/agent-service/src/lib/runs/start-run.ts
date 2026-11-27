import type { RevertResult, StartRunRequest } from '@agent/agent-models';
import {
  HOME_MODE,
  imageAttachments,
  isPlanScoped,
  isReadOnlyPosture,
  isWorkspaceKind,
  lastRunFrom,
  MIN_CONTEXT_WINDOW_TOKENS,
  normalizeRunPosture,
  parseContextWindowMode,
  planHasOpenWork,
  RUN_PAUSED_PREFIX,
  SYSTEM1_AUTO_THINKING,
} from '@agent/agent-models';
import {
  buildEffortPolicy,
  type RunClaim,
  webTrustFromLedger,
  createStreamModelCall,
  createSubagentRunner,
  extraSkillRoots,
  getOllamaModelConfig,
  modelOwnsAuto,
  peekOllamaModelConfig,
  runWithSkillRoots,
  taskRecordFromRun,
} from '@agent/agent-core';

import {
  appendUsageLog,
  capacityEnabled,
  capacityPauseReason,
  capacitySnapshot,
  createCapacityGate,
} from '../models/capacity';
import {
  resolveCallOptions,
  resolveContextBudget,
} from '../models/model-runtime';
import { resolveModelSettings } from '../models/model-settings-store';
import type { AgentService } from '../service';
import { threadTraceSink } from '../platform/trace-sink.js';
import {
  checkpointAfter,
  checkpointBefore,
  folderWriter,
  revertRuns,
} from '../threads/checkpoints';
import { harnessVersion } from '../platform/harness-version';
import { compactThread, emitCompacted, maybeCompactThread } from './compaction';
import {
  endpointFromLocal,
  lastUserEnvelope,
  prepareRun,
  resolveRequestedSkills,
  type MemoryUpdatedPayload,
  type PlanUpdatedPayload,
} from './run-context';
import { createSubagentHost } from './subagent-host';
import { system1EnforceAvailable, system1PortForRun } from './system1-runtime';
import { titleNewThread } from './thread-title';

export type StartRunResult =
  /** `restore`: the files put back before a rewind (`restoreFiles`). */
  | { ok: true; runId: string; restore?: RevertResult }
  | {
      ok: false;
      /** invalid request · unknown thread · thread already running · account usage limit reached */
      reason: 'invalid' | 'not_found' | 'busy' | 'paused';
      error: string;
      /** The active run, when reason is busy. */
      runId?: string;
    };

function reject(
  reason: 'invalid' | 'not_found' | 'busy' | 'paused',
  error: string,
  runId?: string,
): StartRunResult {
  return {
    ok: false,
    reason,
    error,
    ...(runId !== undefined ? { runId } : {}),
  };
}

/**
 * Append the optional user turn to the thread's ledger and start a run on it:
 * admission, context (compacting an oversized start first), model and
 * thinking options, then everything that happens after the run finishes.
 * `request` is already parsed (parseStartRunRequest). Returns once the run is
 * started.
 */
export async function startThreadRun(
  service: AgentService,
  request: StartRunRequest,
): Promise<StartRunResult> {
  // Claim before the first await, so two sends cannot both start a run.
  const claimed = service.runs.claim(request.threadId);
  if (!claimed.ok) {
    return reject(
      'busy',
      'A run is already active for this thread',
      claimed.activeRunId,
    );
  }
  const { claim } = claimed;
  try {
    const result = await startClaimedRun(service, request, claim);
    if (!result.ok) claim.release();
    return result;
  } catch (error) {
    claim.release();
    throw error;
  }
}

async function startClaimedRun(
  service: AgentService,
  request: StartRunRequest,
  claim: RunClaim,
): Promise<StartRunResult> {
  const runId = claim.runId;
  const accountKey = service.config.env.OLLAMA_API_KEY;
  if (!(await claim.ready)) {
    return reject('busy', 'The previous run on this thread is still stopping');
  }

  const {
    threadId,
    message,
    rewindThroughSeq,
    model,
    local,
    webSearch,
    thinking,
    posture: rawPosture,
    skills: rawSkills,
    contextWindowMode: rawWindowMode,
  } = request;
  const posture = normalizeRunPosture(rawPosture);

  const store = await service.threads();
  const found = store.getThread(threadId);
  if (!found) {
    return reject('not_found', 'Thread not found');
  }
  // The window decides when compaction runs, so it lives on the thread:
  // this run and the compaction after it read the same value.
  const windowMode = parseContextWindowMode(rawWindowMode);
  const thread =
    windowMode && windowMode !== (found.contextWindowMode ?? 'default')
      ? (store.updateThread(threadId, { contextWindowMode: windowMode }) ??
        found)
      : found;

  // Sub-agent threads are read-only — user cannot start runs on them (Q4).
  if (thread.parentThreadId) {
    return reject('invalid', 'Sub-agent threads are read-only');
  }

  if (isWorkspaceKind(thread.kind) && !thread.workspaceRoot) {
    return reject('invalid', 'workspace thread has no workspaceRoot');
  }

  // One Agent run writes in a folder at a time: an undo of one run must not
  // take back edits another thread made in the same folder meanwhile.
  // Disabled on purpose: a productive engineer runs several threads on one
  // folder, and the harness must not block the send. Undo keeps its drift
  // check (revertRuns), so a restore never overwrites files changed since.
  const checkpointRoot =
    isWorkspaceKind(thread.kind) &&
    thread.workspaceRoot &&
    !isReadOnlyPosture(posture)
      ? thread.workspaceRoot
      : null;
  // const writer = checkpointRoot ? folderWriter(checkpointRoot) : null;
  // if (writer && writer.threadId !== threadId) {
  //   return reject(
  //     'busy',
  //     'Another thread is running in this folder right now. Wait for it to finish or stop it, then send again (or use Ask, which does not edit).',
  //     writer.runId,
  //   );
  // }

  // The account's usage limit is reached: a run would pause before its
  // first call. Refuse before anything is written (no rewind, no user row),
  // so the message stays with the client to send after the reset.
  const paused =
    endpointFromLocal(local) === 'cloud' ? capacityPauseReason(accountKey) : null;
  if (paused) {
    return reject(
      'paused',
      `${RUN_PAUSED_PREFIX} ${paused}. Your message was not sent; send it again after the reset.`,
    );
  }

  let restore: RevertResult | undefined;
  if (rewindThroughSeq !== undefined) {
    // Restore before the cut: the cut runs' ids live only in the rows being cut.
    if (request.restoreFiles && thread.workspaceRoot) {
      const cutRunIds = [
        ...new Set(
          (await store.readLedger(threadId, 0))
            .filter(
              (envelope) => envelope.seq > rewindThroughSeq && envelope.runId,
            )
            .map((envelope) => envelope.runId as string),
        ),
      ];
      const otherWriter = folderWriter(thread.workspaceRoot);
      if (
        cutRunIds.length > 0 &&
        otherWriter &&
        otherWriter.threadId !== threadId
      ) {
        return reject(
          'busy',
          'Another thread is running in this folder, so files cannot be restored now. Wait for it to finish, or keep the files.',
          otherWriter.runId,
        );
      }
      if (cutRunIds.length > 0) {
        try {
          restore = await revertRuns({
            agentHome: service.home(),
            root: thread.workspaceRoot,
            runIds: cutRunIds,
          });
        } catch (error) {
          return reject(
            'invalid',
            `Files were not restored: ${error instanceof Error ? error.message : String(error)} Nothing was changed; send again and keep the files to go on.`,
          );
        }
      }
    }
    await store.rewind(threadId, rewindThroughSeq);
    await service.learning.rewindCursor(threadId, rewindThroughSeq);
  }

  const ledgerBefore = await store.readLedger(threadId, 0);
  const isFirstUserTurn = ledgerBefore.length === 0 && Boolean(message);
  const priorUser = lastUserEnvelope(ledgerBefore);
  const skillRoots = extraSkillRoots(thread.workspaceRoot);
  const skillNames = runWithSkillRoots(skillRoots, () =>
    resolveRequestedSkills(
      rawSkills,
      message ? undefined : priorUser?.skills?.selected,
    ),
  );

  const useModel = model ?? thread.model ?? HOME_MODE.model;
  const endpoint = endpointFromLocal(local);
  // Resolved once per run (file > env > run's model) and recorded on
  // run.started; consumers below read this snapshot, never env directly.
  const modelSettings = await resolveModelSettings(service, useModel, endpoint);

  // Before the user row is written, so a refusal leaves the ledger as it was.
  if (
    imageAttachments(message?.attachments).length > 0 ||
    ledgerBefore.some(
      (envelope) => imageAttachments(envelope.attachments).length > 0,
    )
  ) {
    try {
      const config = await getOllamaModelConfig(useModel, endpoint);
      if (!config.supportsVision) {
        return reject(
          'invalid',
          'This model does not support images. Pick a vision model.',
        );
      }
    } catch {
      // If /api/show is unavailable, let the model provider reject instead.
    }
  }

  // Also before the user row: a window this small cannot hold the prompt and
  // a real conversation (local Ollama may serve less than the model's size).
  const servedWindow = await resolveContextBudget(
    useModel,
    endpoint,
    thread.contextWindowMode,
  );
  if (servedWindow.budget.windowTokens < MIN_CONTEXT_WINDOW_TOKENS) {
    return reject(
      'invalid',
      servedWindow.source === 'served'
        ? `Local Ollama is serving ${useModel} with a ${servedWindow.budget.windowTokens.toLocaleString()}-token context; the agent needs at least ${MIN_CONTEXT_WINDOW_TOKENS.toLocaleString()}. Raise OLLAMA_CONTEXT_LENGTH on the daemon and restart it.`
        : `${useModel} has a ${servedWindow.budget.windowTokens.toLocaleString()}-token context; the agent needs at least ${MIN_CONTEXT_WINDOW_TOKENS.toLocaleString()}. Pick a model with a larger window.`,
    );
  }

  if (message) {
    await store.append({
      threadId,
      runId: null,
      record: { role: 'user', content: message.content },
      ...(message.attachments?.length
        ? { attachments: message.attachments }
        : {}),
      skills: { selected: skillNames },
    });
  }

  const envelopes = await store.hydrateEnvelopes(threadId);
  if (envelopes.length === 0) {
    return reject('invalid', 'thread has no messages');
  }

  const prepareInput = {
    threadId,
    thread,
    webSearch,
    posture,
    lastUserSeq: store.lastUserSeq(envelopes) ?? 0,
    envelopes,
    model: useModel,
    endpoint,
    skillNames,
    onMemoryUpdated: (payload: MemoryUpdatedPayload) =>
      service.runs.publish(runId, { type: 'memory.updated', runId, ...payload }),
    onPlanUpdated: (payload: PlanUpdatedPayload) =>
      service.runs.publish(runId, {
        type: 'plan.updated',
        runId,
        threadId,
        plan: payload.plan,
      }),
  };
  let prepared = await runWithSkillRoots(skillRoots, () =>
    prepareRun(service, prepareInput),
  );
  // Oversized start (window switched down, big mention, long last run):
  // compact before the first model call instead of carrying it all run.
  const preRunSnapshot = await compactThread({
    store,
    threadId,
    model: useModel,
    endpoint,
    flags: prepared.flags,
    envelopes,
    report: prepared.report,
    modelSettings,
  });
  if (preRunSnapshot)
    prepared = await runWithSkillRoots(skillRoots, () =>
      prepareRun(service, prepareInput),
    );

  // Auto (System 1) starts from the model's default; the router moves from
  // there. A model that lists its own `auto` level gets that value instead.
  // Same guard resolveCallOptions applies, so the policy baseline and the
  // closed-over reasoning_effort always agree.
  const requestedThinking =
    typeof thinking === 'boolean' ||
    (typeof thinking === 'string' && thinking.length > 0)
      ? thinking
      : undefined;
  let callOptions = await resolveCallOptions(
    useModel,
    requestedThinking === SYSTEM1_AUTO_THINKING ? undefined : requestedThinking,
    endpoint,
    prepared.mode.temperature,
  );
  // Cached by resolveCallOptions; never refetched here, so a failed
  // /api/show costs nothing extra (the run then uses a fixed policy).
  const modelConfig = peekOllamaModelConfig(useModel, endpoint) ?? null;
  if (
    requestedThinking === SYSTEM1_AUTO_THINKING &&
    modelConfig &&
    modelOwnsAuto(modelConfig)
  ) {
    callOptions = await resolveCallOptions(
      useModel,
      requestedThinking,
      endpoint,
      prepared.mode.temperature,
    );
  }
  const modelCall = createStreamModelCall(callOptions);
  const effortPolicy = buildEffortPolicy(
    modelConfig,
    requestedThinking,
    system1EnforceAvailable(service.system1, endpoint),
  );
  const system1 = system1PortForRun(service.system1, endpoint, prepared.mode.limits.maxWallMs);
  // Cloud runs share one account: pause on a spent session/week instead of
  // erroring, and steer tighter when behind even weekly pace.
  const capacity =
    endpoint === 'cloud' && capacityEnabled(accountKey)
      ? createCapacityGate(accountKey)
      : undefined;
  const balanceBefore = capacitySnapshot(accountKey);

  // The run's task record, written as it grows and once more at the end.
  // Writes are chained so an older snapshot never lands after a newer one
  // (each write replaces this run's record in the file).
  let recordWrites: Promise<void> = Promise.resolve();
  const saveTaskRecord = (
    task: Parameters<typeof taskRecordFromRun>[1],
  ): void => {
    const record = taskRecordFromRun(runId, task);
    if (!record) return;
    recordWrites = recordWrites
      .then(() => store.appendTaskRecord(threadId, record))
      .catch((error: unknown) => {
        console.error(
          'appendTaskRecord failed:',
          error instanceof Error ? error.message : error,
        );
      });
  };

  // Replaced in onFinished; survives only if the server stops mid-run.
  await store.writeLastRun(
    threadId,
    lastRunFrom({ runId, outcome: 'interrupted', iterations: 0, toolCalls: 0 }),
  );

  // Last step before the run: nothing below can refuse it, and no tool runs
  // before this snapshot exists. A failed snapshot is logged and the run goes
  // on without undo (the Changes view then says no snapshot exists).
  const agentHome = service.home();
  if (checkpointRoot)
    await checkpointBefore({
      agentHome,
      root: checkpointRoot,
      runId,
      threadId,
    });
  const codeVersion = await harnessVersion();

  // First turn's title: titleNewThread writes the seed synchronously and
  // resolves once the model's replacement is on disk (or failed → seed
  // stands). onFinished waits for that, bounded, so run.settled — the
  // client's last thread-list refresh — usually carries the final title.
  const TITLE_SETTLE_WAIT_MS = 3_000;
  let titleLanded: Promise<void> | undefined;

  claim.start(
    {
      model: useModel,
      messages: prepared.messages,
      tools: prepared.tools,
      modelCall,
      limits: prepared.mode.limits,
      mode: prepared.mode.name,
      posture: prepared.posture,
      estimatedPromptTokens: prepared.report.occupiedTokens,
      contextReport: prepared.report,
      contextBudget: prepared.report.budget,
      flags: prepared.flags,
      ...(codeVersion ? { harnessVersion: codeVersion } : {}),
      modelSettings,
      ...(thread.workspaceRoot ? { workspaceRoot: thread.workspaceRoot } : {}),
      putBlob: (text) => store.putBlob(threadId, text),
      // Every model call's exact input/output, for the eval viewer. Off: AGENT_RECORD_MODEL_CALLS=0.
      recordCalls: service.config.env.AGENT_RECORD_MODEL_CALLS !== '0',
      readBlob: (sha256, offset, length) =>
        store.readBlobText(threadId, sha256, offset, length),
      onMessage: async (record, meta) => {
        if (record.role === 'system') return;
        await store.append({
          threadId,
          runId,
          record,
          ...(meta ? { meta } : {}),
        });
      },
      hasOpenPlanWork: async () =>
        planHasOpenWork(await store.readPlan(threadId)),
      isPlanScoped: async () => isPlanScoped(await store.readPlan(threadId)),
      // Saved as it grows, so a run that dies keeps its findings.
      onTaskRecord: (task) => saveTaskRecord(task),
      // The loop binds the runner to this run (signal, budget, capabilities).
      ...(isWorkspaceKind(thread.kind) && thread.workspaceRoot
        ? {
            subagents: createSubagentRunner({
              runManager: service.runs,
              host: createSubagentHost({ store, endpoint, modelSettings, accountKey }),
            }),
          }
        : {}),
      trace: threadTraceSink(store, threadId),
      ...(skillNames.length > 0 ? { pinnedSkills: skillNames } : {}),
      ...(skillRoots.length > 0 ? { skillRoots } : {}),
      ...(capacity ? { capacity } : {}),
      ...(system1 ? { system1 } : {}),
      effortPolicy,
      webTrust: webTrustFromLedger(envelopes),
    },
    {
      onFinished: async (result, outcome) => {
        // First, so the run's changes are readable once the run has settled,
        // and the folder is free for the next writer (whatever the outcome).
        if (checkpointRoot)
          await checkpointAfter({ agentHome, root: checkpointRoot, runId });
        // Not awaited: the balance read after a run must not delay compaction.
        void appendUsageLog(accountKey, agentHome, {
          runId: result.runId,
          threadId,
          model: useModel,
          endpoint,
          status: result.status,
          ...(result.limitReason ? { limitReason: result.limitReason } : {}),
          usage: result.usage,
          balanceBefore,
        });
        try {
          await store.writeLastRun(
            threadId,
            lastRunFrom({
              runId,
              outcome,
              iterations: result.iterations,
              toolCalls: result.toolCalls,
              ...(result.limitReason
                ? { limitReason: result.limitReason }
                : {}),
              // Keeps the System 1 notice across a reload (the SSE event is live-only).
              ...(system1 ? { system1: system1.report() } : {}),
            }),
          );
        } catch (error) {
          console.error(
            'writeLastRun failed:',
            error instanceof Error ? error.message : error,
          );
        }
        // The run's findings outlive it: later runs of the thread see them in
        // their prompt prefix (a rewind that cuts this run drops them). The
        // final record goes after any save still in flight, so it is the last.
        saveTaskRecord(result.task);
        await recordWrites;
        // Restarts the idle timer; the review runs once the thread goes quiet.
        service.learning.schedule({
          threadId,
          model: useModel,
          endpoint,
          enabled: prepared.flags.learningLoop,
          modelSettings,
        });
        // The first turn's title, before run.settled goes out: the client's
        // settle-time refresh is the last one that shows it without a new
        // send or navigation. Bounded: a slow title path must not hold the
        // run's end hostage; a late title still writes for the next refresh.
        if (titleLanded) {
          let settleTimer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              titleLanded,
              new Promise<void>((resolve) => {
                settleTimer = setTimeout(resolve, TITLE_SETTLE_WAIT_MS);
              }),
            ]);
          } finally {
            clearTimeout(settleTimer);
          }
        }
        // A cancelled run leaves compaction to the next run's pre-run pass, so
        // nothing it writes can race that run's rewind.
        if (outcome === 'cancelled' || !result.contextReport) return;
        await maybeCompactThread({
          runs: service.runs,
          store,
          threadId,
          runId,
          model: useModel,
          endpoint,
          flags: prepared.flags,
          report: result.contextReport,
          modelSettings,
        });
      },
    },
  );

  service.runs.publish(runId, {
    type: 'plan.updated',
    runId,
    threadId,
    plan: await store.readPlan(threadId),
  });
  if (preRunSnapshot) emitCompacted(service.runs, store, runId, threadId, preRunSnapshot);

  if (isFirstUserTurn && message) {
    titleLanded = titleNewThread(
      store,
      threadId,
      message.content || 'Image chat',
      useModel,
      endpoint,
      modelSettings,
    );
  }

  return { ok: true, runId, ...(restore ? { restore } : {}) };
}
