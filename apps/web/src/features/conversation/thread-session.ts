import {
  isThreadPlanEmpty,
  normalizeRunPosture,
  revertSummary,
  type ActiveRun,
  type RevertResult,
  type AgentEvent,
  type LedgerResponse,
  type Message,
  type MessageAttachment,
  type ThreadPlan,
} from '@agent/agent-models';
import {
  cancelRun,
  queueRun,
  resolveChoice,
  sendQueuedRun,
  startRun,
  subscribeRun,
  takeQueuedRun,
  type ComposerOptions,
} from '@/api/agent-client';
import { fetchLedger, seqFromMessageId } from '@/api/thread-client';
import { resolveOllamaModel } from '@/features/composer/ollama-models';
import { skillTokensInText } from '@/features/composer/skill-slash-picker';
import { getThreadsSnapshot, refreshThreads } from '@/features/threads/thread-cache';
import { toastError, toastSuccess } from '@/hooks/use-toast';
import {
  applyChatEvent,
  hasSseSeqGap,
  initialChatState,
  limitNoticeFromIncomplete,
  noticeFromSnapshot,
  persistChatEffects,
  type ChatRunState,
  type ChatState,
  type CompactionNotice,
} from './chat-store';
import { observeRunEvent } from './run-alerts';

export type QueuedMessage = {
  content: string;
  options: ComposerOptions;
  attachments?: MessageAttachment[];
  /** Why the host could not start it; it stays queued. */
  refused?: string;
  /**
   * Held by this tab only: a send that failed to start. Every other queued
   * message is held by the host, which starts it when the run settles.
   */
  local?: true;
};

export type ThreadView = {
  messages: Message[];
  chat: ChatState;
  queued: QueuedMessage | null;
  /** A POST /run is in flight: the thread counts as busy, sends queue. */
  starting: boolean;
};

export type ChoiceAnswer = { skipped: true } | { optionIds: string[]; text?: string };

/** The HTTP calls the session makes; tests can pass their own. */
const http = { startRun, subscribeRun, cancelRun, resolveChoice, fetchLedger, queueRun, takeQueuedRun, sendQueuedRun };

/** The host's queued message as the composer shows it. */
function queuedFromLedger(ledger: LedgerResponse): QueuedMessage | null {
  const queued = ledger.queued;
  if (!queued) return null;
  const saved = (queued.composer ?? {}) as { options?: ComposerOptions };
  const { content, attachments } = queued.request.message;
  return {
    content,
    // Only `skills` is read back (take-back into the composer).
    options: saved.options ?? ({} as ComposerOptions),
    ...(attachments ? { attachments } : {}),
    ...(queued.refused ? { refused: queued.refused } : {}),
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** After files were put back: a plain success, or a warning naming what stayed. */
export function showRestoreResult(result: RevertResult): void {
  const partial = result.conflicts.length > 0 || result.failed.length > 0 || result.skipped.length > 0;
  if (partial) toastError(revertSummary(result), 'Some files were not restored');
  else toastSuccess(revertSummary(result), 'Files restored');
}
export type ThreadTransport = typeof http;

/**
 * A plan is current iff it was written after the thread's last user message
 * (plan revisions are stamped with the ledger seq of the tool row that
 * followed their write). Older plans belong to settled turns: they render as
 * chips from history, never as live state.
 */
function planFromLedger(ledger: LedgerResponse): ThreadPlan | null {
  const { plan, lastUserSeq } = ledger;
  if (!plan || isThreadPlanEmpty(plan) || lastUserSeq === undefined) return null;
  return (plan.ledgerSeq ?? 0) > lastUserSeq ? plan : null;
}

/** The snapshot on disk, unless the stream already reported a newer one. */
function compactionFromLedger(
  ledger: LedgerResponse,
  live: CompactionNotice | null,
): CompactionNotice | null {
  if (!ledger.snapshot) return live?.status === 'running' ? live : null;
  const fromDisk = noticeFromSnapshot(ledger.snapshot);
  return live && live.throughSeq > fromDisk.throughSeq ? live : fromDisk;
}

/**
 * What the ledger decides about a thread, used on load, at every run's end,
 * and after retry/edit, so all of them agree with a reload. Notices belong to
 * the last settled run, and only while its reply is the newest in the thread.
 */
function viewFromLedger(
  ledger: LedgerResponse,
  live: ChatState,
): Pick<ChatState, 'plan' | 'compactionNotice' | 'limitNotice' | 'system1Notice'> {
  const lastReply = ledger.messages.findLast((m) => m.role === 'assistant');
  const lastRun =
    ledger.lastRun && !ledger.activeRun && ledger.lastRun.runId === lastReply?.runId
      ? ledger.lastRun
      : undefined;
  return {
    plan: planFromLedger(ledger),
    compactionNotice: compactionFromLedger(ledger, live.compactionNotice),
    limitNotice: limitNoticeFromIncomplete(lastRun) ?? null,
    system1Notice: lastRun?.system1
      ? { runId: lastRun.runId, report: lastRun.system1 }
      : null,
  };
}

/** The live run as the ledger reports it, before (or without) its opening events. */
function runFromSummary(run: ActiveRun): ChatRunState {
  return {
    runId: run.runId,
    status: 'running',
    model: run.model,
    posture: run.posture,
    streamingMessage: null,
    toolActivity: [],
    subagentActivity: [],
    assistantSnippets: [],
    lastSeq: 0,
    ...(run.startedAt ? { runStartedAt: run.startedAt } : {}),
  };
}

function runRequest(options: ComposerOptions) {
  const local = options.local === true;
  return {
    webSearch: options.webSearch,
    model: resolveOllamaModel(options.model, local),
    local,
    thinking: options.thinking,
    posture: normalizeRunPosture(options.posture),
    ...(options.skills ? { skills: options.skills } : {}),
    contextWindowMode: options.contextWindowMode ?? 'default',
  };
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export type ThreadSession = ReturnType<typeof createThreadSession>;

/**
 * One thread's conversation state outside React: the ledger view, the live
 * run (one event stream at a time), the queued message, and every action
 * that starts or steers a run. React reads it through `useSyncExternalStore`.
 */
export function createThreadSession(
  threadId: string,
  transport: ThreadTransport = http,
) {
  let view: ThreadView = {
    messages: [],
    chat: initialChatState(),
    queued: null,
    starting: false,
  };
  const listeners = new Set<() => void>();
  let disposed = false;
  let disconnect: (() => void) | null = null;

  function update(next: Partial<ThreadView>): void {
    if (disposed) return;
    view = { ...view, ...next };
    for (const listener of listeners) listener();
  }

  const busy = () => view.starting || view.chat.activeRun !== null;

  /** Rebuild from the ledger; attach to the run in progress, if any. */
  async function load(): Promise<void> {
    let ledger: LedgerResponse;
    try {
      ledger = await transport.fetchLedger(threadId);
    } catch (error) {
      console.error('Failed to load ledger', error);
      return;
    }
    if (disposed) return;
    const active = ledger.activeRun;
    const chat: ChatState = {
      ...initialChatState(),
      ...viewFromLedger(ledger, view.chat),
      ...(active
        ? {
            activeRun: runFromSummary(active),
            pendingChoices: active.pendingChoices.map((choice) => ({
              ...choice,
              runId: active.runId,
            })),
          }
        : {}),
    };
    update({ messages: ledger.messages, chat, queued: queuedOf(ledger) });
    if (active) follow(active.runId);
  }

  /** The host's queued message, or this tab's own (a send that failed to start). */
  function queuedOf(ledger: LedgerResponse): QueuedMessage | null {
    return queuedFromLedger(ledger) ?? (view.queued?.local ? view.queued : null);
  }

  /** The ledger once the host has started the queued message (it starts right after a settle). */
  async function ledgerAfterQueue(): Promise<LedgerResponse> {
    let ledger = await transport.fetchLedger(threadId);
    for (let i = 0; i < 20 && ledger.queueStarting && !ledger.activeRun && !disposed; i++) {
      await sleep(500);
      ledger = await transport.fetchLedger(threadId);
    }
    return ledger;
  }

  /**
   * The run ended (run.settled): one ledger read updates messages and notices
   * together, and follows the queued message's run when the host started one.
   */
  async function settle(): Promise<void> {
    try {
      const ledger = await ledgerAfterQueue();
      if (disposed) return;
      const next = ledger.activeRun;
      const queued = queuedOf(ledger);
      if (queued?.refused && queued.refused !== view.queued?.refused) {
        toastError(queued.refused, 'Queued message not sent');
      }
      update({
        messages: ledger.messages,
        queued,
        chat: {
          ...view.chat,
          ...viewFromLedger(ledger, view.chat),
          // Ledger holds the committed messages now; clear the live run and
          // bridge in one update so there's no flash between them.
          activeRun: next ? runFromSummary(next) : null,
          pendingChoices: next ? next.pendingChoices.map((choice) => ({ ...choice, runId: next.runId })) : [],
          settledSnippets: [],
          settledToolActivity: [],
        },
      });
      if (next) follow(next.runId);
    } catch {
      // Ledger refetch failed — still clear the live run so the UI doesn't
      // hang in "running" forever. The next load rebuilds from disk.
      update({
        chat: {
          ...view.chat,
          activeRun: null,
        },
      });
    }
    void refreshThreads();
    if (!busy() && view.queued?.local) void flushQueue();
  }

  async function refreshMessages(): Promise<void> {
    try {
      const ledger = await transport.fetchLedger(threadId);
      if (!disposed) update({ messages: ledger.messages });
    } catch {
      // Best effort: the run's end refetches anyway.
    }
  }

  /** Stream one run's events into the view. A new run replaces the old stream. */
  function follow(runId: string): void {
    disconnect?.();
    let chain = Promise.resolve();
    const unsubscribe = transport.subscribeRun(
      runId,
      view.chat.activeRun?.runId === runId ? view.chat.activeRun.lastSeq : 0,
      (event: AgentEvent) => {
        chain = chain.then(async () => {
          if (disposed || disconnect !== unsubscribe) return;
          const prev = view.chat;
          // A run attached from the ledger starts at seq 0 and its first
          // replayed event is usually far ahead; that read already happened.
          // A gap before assistant.completed is the server folding that
          // message's deltas into its content: nothing is missing.
          const lastSeq = prev.activeRun?.lastSeq ?? 0;
          if (lastSeq > 0 && event.type !== 'assistant.completed' && hasSseSeqGap(lastSeq, event.seq)) {
            void refreshMessages();
          }
          await persistChatEffects(prev, event, threadId);
          if (disposed || disconnect !== unsubscribe) return;
          update({ chat: applyChatEvent(view.chat, event) });
          observeRunEvent({
            event,
            subscribedRunId: runId,
            subscribedThreadId: threadId,
            liveThreadId: threadId,
            // Read per event: the title is generated after the first run.
            threadTitle:
              getThreadsSnapshot().find((thread) => thread.id === threadId)?.title ?? null,
          });
          if (event.type === 'context.compacted') void refreshMessages();
          if (event.type === 'run.settled') {
            disconnect = null;
            await settle();
          }
        });
      },
      (error) => {
        console.error('SSE error:', error);
        if (disposed || disconnect !== unsubscribe) return;
        // The stream gave up (server restarted, run unknown): the ledger
        // says whether a run is still going; follow it, or show the end.
        disconnect = null;
        void reconcile();
      },
    );
    disconnect = unsubscribe;
  }

  /** After a lost stream: rebuild from the ledger, then send this tab's unsent message if nothing runs. */
  async function reconcile(): Promise<void> {
    await load();
    void refreshThreads();
    if (!busy() && view.queued?.local) void flushQueue();
  }

  /**
   * POST /run, then show the ledger it wrote and follow the run. A failed
   * start keeps the message: it goes back to the queue chip.
   */
  async function start(
    request: Parameters<ThreadTransport['startRun']>[1],
    unsent?: QueuedMessage,
  ): Promise<void> {
    update({ starting: true });
    disconnect?.();
    disconnect = null;
    try {
      const started = await transport.startRun(threadId, request);
      if (started.restore) showRestoreResult(started.restore);
    } catch (error) {
      update({ starting: false, ...(unsent ? { queued: { ...unsent, local: true } } : {}) });
      toastError(errorMessage(error, 'Could not start the run'), 'Send failed');
      // The thread may have changed (a user row is kept; Retry re-runs it).
      await refreshMessages();
      return;
    }
    // Title and recency changed; the sidebar picks them up.
    void refreshThreads();
    await load();
    update({ starting: false });
  }

  /** Start this tab's unsent message (a send that failed to start); the host starts its own queue. */
  async function flushQueue(): Promise<void> {
    const queued = view.queued;
    if (!queued?.local) return;
    update({ queued: null });
    await start(
      {
        message: { content: queued.content, attachments: queued.attachments },
        ...runRequest(queued.options),
      },
      queued,
    );
  }

  /**
   * Starts now, or, while a run is live, queues on the host (replacing a
   * message already queued); the host starts it when that run settles.
   */
  async function send(
    content: string,
    options: ComposerOptions,
    attachments?: MessageAttachment[],
  ): Promise<void> {
    const message: QueuedMessage = { content, options, ...(attachments ? { attachments } : {}) };
    const request = { message: { content, attachments }, ...runRequest(options) };
    if (!busy()) {
      await start(request, message);
      return;
    }
    update({ queued: message });
    try {
      await transport.queueRun(threadId, request, { options });
    } catch (error) {
      update({ queued: { ...message, local: true } });
      toastError(errorMessage(error, 'Could not queue the message'), 'Queue failed');
      return;
    }
    // The run may have ended while this was sent: the host then started the message.
    if (!busy()) await settle();
  }

  /**
   * Stop the live run. The stream then reports the cancel and, once the run
   * has written its last rows, its end; nothing is cleared by hand here.
   */
  async function stop(): Promise<void> {
    const run = view.chat.activeRun;
    if (!run) return;
    let active: boolean;
    try {
      active = await transport.cancelRun(run.runId);
    } catch (error) {
      toastError(errorMessage(error, 'Could not stop the run'), 'Stop failed');
      return;
    }
    if (active) return;
    // Already over: the ledger has the result.
    disconnect?.();
    disconnect = null;
    update({ chat: { ...view.chat, activeRun: null } });
    await settle();
  }

  /** Stop the live run and start the queued message (the server waits for the stop). */
  async function sendQueuedNow(posture: ComposerOptions['posture']): Promise<void> {
    const queued = view.queued;
    if (!queued) return;
    // The posture chip as it is now wins over the one frozen at enqueue.
    if (queued.local) {
      update({ queued: { ...queued, options: { ...queued.options, posture } } });
      await stop();
      await flushQueue();
      return;
    }
    try {
      await transport.sendQueuedRun(threadId, normalizeRunPosture(posture));
    } catch (error) {
      toastError(errorMessage(error, 'Could not send the queued message'), 'Send failed');
      return;
    }
    // Nothing was running, so the host started it now; otherwise the stop's settle follows it.
    if (!view.chat.activeRun) await settle();
  }

  /**
   * Run the last user message again: rewind past the reply, or, when the
   * thread ends with that message (the start failed or was stopped before
   * any reply), run it as it is.
   */
  async function retry(options: ComposerOptions, restoreFiles = false): Promise<void> {
    if (busy()) return;
    const { lastUserSeq, lastSeq } = await transport.fetchLedger(threadId);
    if (lastUserSeq === undefined) return;
    await start({
      ...(lastUserSeq === lastSeq
        ? {}
        : { rewindThroughSeq: lastUserSeq, ...(restoreFiles ? { restoreFiles: true } : {}) }),
      ...runRequest(options),
    });
  }

  /**
   * Replace the last user message and run it. `restoreFiles`: also put back
   * the files the replaced reply changed.
   */
  async function edit(
    messageId: string,
    content: string,
    options: ComposerOptions,
    restoreFiles = false,
  ): Promise<void> {
    const trimmed = content.trim();
    const lastUser = view.messages.findLast((m) => m.role === 'user');
    const userSeq = seqFromMessageId(messageId);
    if (!lastUser || lastUser.id !== messageId || userSeq === undefined) return;
    if (!trimmed && !(lastUser.attachments?.length ?? 0)) return;
    await stop();
    const requested = skillTokensInText(trimmed);
    await start({
      rewindThroughSeq: userSeq - 1,
      ...(restoreFiles ? { restoreFiles: true } : {}),
      message: { content: trimmed, attachments: lastUser.attachments },
      ...runRequest(options),
      ...(requested.length > 0 ? { skills: { requested } } : {}),
    });
  }

  /** Answer a choice the run is paused on (its own run id survives a reload). */
  async function answerChoice(choiceId: string, answer: ChoiceAnswer): Promise<void> {
    const choice = view.chat.pendingChoices.find((c) => c.choiceId === choiceId);
    if (!choice) return;
    // The toast here is the single error surface; callers only reset busy state.
    try {
      await transport.resolveChoice(
        choice.runId,
        'skipped' in answer ? { choiceId, skipped: true } : { choiceId, ...answer },
      );
    } catch (error) {
      toastError(errorMessage(error, 'Could not send choice'), 'Choice failed');
    }
  }

  void load();

  return {
    getSnapshot: (): ThreadView => view,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    send,
    sendQueuedNow,
    /** Take the queued message back into the composer. */
    takeQueued(): QueuedMessage | null {
      const queued = view.queued;
      update({ queued: null });
      if (queued && !queued.local) {
        void transport.takeQueuedRun(threadId).catch((error: unknown) => {
          toastError(errorMessage(error, 'The host still holds the queued message'), 'Take back failed');
        });
      }
      return queued;
    },
    stop,
    retry,
    edit,
    answerChoice,
    dispose(): void {
      disposed = true;
      disconnect?.();
      disconnect = null;
      listeners.clear();
    },
  };
}
