import type {
  AgentEvent,
  ContextReport,
  ContextWindowMode,
  MemoryCaps,
  MemoryFiles,
  MemoryOp,
  MessageAttachment,
  ModelSettings,
  OllamaBalance,
  OllamaEndpoint,
  OllamaListedModel,
  OllamaModelConfig,
  QueuedMessage,
  ResolvedModelSettings,
  RevertResult,
  RunPosture,
  StartRunRequest,
  ThinkingValue,
} from '@agent/agent-models';
import { normalizeRunPosture } from '@agent/agent-models';

import { api } from './client';

/* ---------- Pending message (cross-route handoff) ---------- */

const PENDING_MSG_KEY = 'desk:pendingMessage';

export type ComposerSkillHints = {
  requested?: string[];
};

export type ComposerOptions = {
  webSearch: boolean;
  model: string;
  /** Route chat + discovery to local Ollama daemon. */
  local?: boolean;
  /** Model-specific thinking: false / true / effort name from `/api/show`. */
  thinking?: ThinkingValue;
  /** Workspace-only Ask | Agent. Default agent. Ignored on Home. */
  posture?: RunPosture;
  /** User-requested skills from `/` picks. */
  skills?: ComposerSkillHints;
  /** 260k default window vs the model's full size. Persisted on the thread by /run. */
  contextWindowMode?: ContextWindowMode;
};

export type PendingMessage = {
  content: string;
  webSearch?: boolean;
  model?: string;
  local?: boolean;
  thinking?: ThinkingValue;
  posture?: RunPosture;
  attachments?: MessageAttachment[];
  skills?: ComposerSkillHints;
  contextWindowMode?: ContextWindowMode;
};

/**
 * Stash a message for the chat page to send on mount.
 * Returns false when sessionStorage rejects the payload (quota / private mode).
 */
export function stashPendingMessage(msg: PendingMessage): boolean {
  try {
    sessionStorage.setItem(PENDING_MSG_KEY, JSON.stringify(msg));
    return true;
  } catch {
    return false;
  }
}

/** Read and clear the stashed message. Returns null if none. */
export function takePendingMessage(): PendingMessage | null {
  const raw = sessionStorage.getItem(PENDING_MSG_KEY);
  if (!raw) return null;
  sessionStorage.removeItem(PENDING_MSG_KEY);
  return JSON.parse(raw) as PendingMessage;
}

/**
 * Start an agent run. History is owned by the API ledger.
 */
export async function startRun(
  threadId: string,
  options: {
    message?: { content: string; attachments?: MessageAttachment[] };
    rewindThroughSeq?: number;
    /** With a rewind: put back the files the cut reply changed. */
    restoreFiles?: boolean;
    model?: string;
    local?: boolean;
    webSearch?: boolean;
    thinking?: ThinkingValue;
    posture?: RunPosture;
    skills?: ComposerSkillHints;
    contextWindowMode?: ContextWindowMode;
  } = {},
): Promise<{ runId: string; restore?: RevertResult }> {
  const body: StartRunRequest = {
    threadId,
    message: options.message,
    rewindThroughSeq: options.rewindThroughSeq,
    ...(options.restoreFiles ? { restoreFiles: true } : {}),
    model: options.model,
    local: options.local,
    webSearch: options.webSearch,
    thinking: options.thinking,
    posture: normalizeRunPosture(options.posture),
    ...(options.skills ? { skills: options.skills } : {}),
    ...(options.contextWindowMode
      ? { contextWindowMode: options.contextWindowMode }
      : {}),
  };

  const res = await api.request('runs.start', { init: {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  } });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Failed to start run: ${res.status}`);
  }

  const { runId, restore } = (await res.json()) as { runId: string; restore?: RevertResult };
  return { runId, ...(restore ? { restore } : {}) };
}

async function failure(res: Response, fallback: string): Promise<Error> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return new Error(body.error ?? `${fallback}: ${res.status}`);
}

/**
 * Queue a message on the host until the thread's run ends (it replaces one
 * already queued). `composer` comes back on take-back.
 */
export async function queueRun(
  threadId: string,
  request: Omit<NonNullable<Parameters<typeof startRun>[1]>, 'rewindThroughSeq' | 'restoreFiles'>,
  composer: unknown,
): Promise<QueuedMessage> {
  const res = await api.request('threads.queue', {
    params: { id: threadId },
    init: {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ request: { ...request, posture: normalizeRunPosture(request.posture) }, composer }),
    },
  });
  if (!res.ok) throw await failure(res, 'Failed to queue the message');
  return ((await res.json()) as { queued: QueuedMessage }).queued;
}

/** Take the queued message back off the host. */
export async function takeQueuedRun(threadId: string): Promise<void> {
  const res = await api.request('threads.takeQueued', { params: { id: threadId } });
  if (!res.ok) throw await failure(res, 'Failed to take the queued message back');
}

/** Stop the run going and send the queued message (the host waits for the stop). */
export async function sendQueuedRun(threadId: string, posture: RunPosture | undefined): Promise<void> {
  const res = await api.request('threads.sendQueued', {
    params: { id: threadId },
    init: {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(posture ? { posture } : {}),
    },
  });
  if (!res.ok) throw await failure(res, 'Failed to send the queued message');
}

/**
 * Subscribe to a run's SSE event stream.
 * Replays events from fromSeq, then streams live events.
 *
 * Returns an unsubscribe function.
 */
export function subscribeRun(
  runId: string,
  fromSeq: number,
  onEvent: (event: AgentEvent) => void,
  onError?: (error: Error) => void,
): () => void {
  let closed = false;
  let cursor = fromSeq;
  let retries = 0;
  let source: EventSource | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const connect = () => {
    if (closed) return;
    const url = api.url('runs.events', { runId }, `fromSeq=${cursor}`);
    const es = new EventSource(url);
    source = es;

    es.onmessage = (e) => {
      retries = 0;
      try {
        const event = JSON.parse(e.data) as AgentEvent;
        if (typeof event.seq === 'number') {
          cursor = Math.max(cursor, event.seq);
        }
        onEvent(event);
        if (event.type === 'run.settled') {
          closed = true;
          es.close();
        }
      } catch (err) {
        onError?.(err instanceof Error ? err : new Error(String(err)));
      }
    };

    es.addEventListener('done', () => {
      closed = true;
      es.close();
    });

    es.onerror = () => {
      es.close();
      if (closed) return;
      retries += 1;
      // A settled run answers with its end, so repeated failures mean the
      // server no longer knows the run (restarted): give up in ~7 s and let
      // the caller reconcile from the ledger.
      if (retries > 3) {
        onError?.(new Error('SSE connection lost'));
        return;
      }
      const delay = Math.min(1000 * 2 ** (retries - 1), 8000);
      reconnectTimer = setTimeout(connect, delay);
    };
  };

  connect();

  return () => {
    closed = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    source?.close();
  };
}

export async function fetchOllamaModelConfig(
  model: string,
  endpoint: OllamaEndpoint = 'cloud',
): Promise<OllamaModelConfig> {
  const params = new URLSearchParams({ model, endpoint });
  const res = await api.request('models.config', { query: params.toString() });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Failed to load model config: ${res.status}`);
  }
  return res.json() as Promise<OllamaModelConfig>;
}

export type LocalOllamaModelsResponse = {
  endpoint: OllamaEndpoint;
  models: OllamaListedModel[];
};

/** Discover models installed on the API host's local Ollama (`/api/tags`). */
export async function fetchLocalOllamaModels(): Promise<LocalOllamaModelsResponse> {
  const res = await api.request('models.list', { query: 'endpoint=local' });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Failed to list local models: ${res.status}`);
  }
  return res.json() as Promise<LocalOllamaModelsResponse>;
}

/** Discover cloud models from Ollama Cloud (`/api/tags` at ollama.com). */
export async function fetchCloudOllamaModels(): Promise<LocalOllamaModelsResponse> {
  const res = await api.request('models.list', { query: 'endpoint=cloud' });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Failed to list cloud models: ${res.status}`);
  }
  return res.json() as Promise<LocalOllamaModelsResponse>;
}

export type ModelSettingsView = {
  settings: ModelSettings;
  resolved: ResolvedModelSettings;
};

/** Stored model-role picks and their resolution, for Settings → Models. */
export async function getModelSettings(): Promise<ModelSettingsView> {
  const res = await api.request('models.getSettings');
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Failed to load model settings: ${res.status}`);
  }
  return res.json() as Promise<ModelSettingsView>;
}

/** Persist model-role picks. Invalid bodies are a 400 with `problems`. */
export async function putModelSettings(
  settings: ModelSettings,
): Promise<ModelSettingsView> {
  const res = await api.request('models.putSettings', { init: {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  } });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const problems = Array.isArray((body as { problems?: unknown }).problems)
      ? ((body as { problems: string[] }).problems.join('; '))
      : '';
    throw new Error(
      problems || (body as { error?: string }).error || `Failed to save model settings: ${res.status}`,
    );
  }
  return res.json() as Promise<ModelSettingsView>;
}

/** Fetch Ollama Cloud balance (session/weekly limits or USD credits). */
export async function fetchOllamaBalance(): Promise<OllamaBalance> {
  const res = await api.request('usage.balance');
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Failed to load balance: ${res.status}`);
  }
  return res.json() as Promise<OllamaBalance>;
}

export type ContextEstimateResponse = {
  estimatedPromptTokens: number;
  contextLength: number | null;
  source: 'estimate';
  contextReport: ContextReport;
};

/** Same assembleContext path as /run: host ledger + memory + optional draft. */
export async function fetchContextEstimate(options: {
  threadId?: string;
  draft?: string;
  attachments?: MessageAttachment[];
  model?: string;
  local?: boolean;
  webSearch?: boolean;
  posture?: RunPosture;
  skills?: ComposerSkillHints;
  contextWindowMode?: ContextWindowMode;
}): Promise<ContextEstimateResponse> {
  const res = await api.request('runs.estimate', { init: {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      threadId: options.threadId,
      draft: options.draft,
      attachments: options.attachments,
      model: options.model,
      local: options.local,
      webSearch: options.webSearch,
      posture: normalizeRunPosture(options.posture),
      ...(options.skills ? { skills: options.skills } : {}),
      ...(options.contextWindowMode
        ? { contextWindowMode: options.contextWindowMode }
        : {}),
    }),
  } });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Failed to estimate context: ${res.status}`);
  }
  return res.json() as Promise<ContextEstimateResponse>;
}

export type MemoryResponse = {
  files: MemoryFiles;
  ops: MemoryOp[];
  caps: MemoryCaps;
};

export async function fetchMemory(): Promise<MemoryResponse> {
  const res = await api.request('memory.get');
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Failed to load memory: ${res.status}`);
  }
  return res.json() as Promise<MemoryResponse>;
}

export async function saveUserMemory(
  user: string,
  threadId?: string,
): Promise<MemoryOp> {
  const res = await api.request('memory.update', { init: {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user, threadId }),
  } });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Failed to save profile: ${res.status}`);
  }
  const { op } = (await res.json()) as { op: MemoryOp };
  return op;
}

/** Memory suggestions waiting for approval (learning loop and staged writes). */
export async function fetchPendingMemory(): Promise<MemoryOp[]> {
  const res = await api.request('memory.pending');
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Failed to load suggestions: ${res.status}`);
  }
  const { ops } = (await res.json()) as { ops: MemoryOp[] };
  return ops;
}

export async function resolvePendingMemory(
  opId: string,
  decision: 'approve' | 'reject',
): Promise<MemoryOp> {
  const res = await api.request('memory.resolvePending', { params: { opId }, init: {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ decision }),
  } });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Failed to ${decision} suggestion: ${res.status}`);
  }
  const { op } = (await res.json()) as { op: MemoryOp };
  return op;
}

export async function revertMemoryOp(opId: string): Promise<MemoryOp> {
  const res = await api.request('memory.revert', { init: {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ opId }),
  } });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Failed to revert memory: ${res.status}`);
  }
  const { op } = (await res.json()) as { op: MemoryOp };
  return op;
}

/** False when the run is no longer active (it already ended). */
export async function cancelRun(runId: string): Promise<boolean> {
  const res = await api.request('runs.cancel', { params: { runId } });
  if (res.status === 404) return false;
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Failed to cancel run: ${res.status}`);
  }
  return true;
}

export async function resolveChoice(
  runId: string,
  body:
    | { choiceId: string; skipped: true }
    | { choiceId: string; optionIds: string[]; text?: string },
): Promise<void> {
  const res = await api.request('runs.choice', { params: { runId }, init: {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  } });
  if (!res.ok) {
    const payload = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(
      payload.error ?? `Failed to resolve choice: ${res.status}`,
    );
  }
}
