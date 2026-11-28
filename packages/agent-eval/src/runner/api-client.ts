import { createAgentClient, type AgentClient } from '@agent/agent-client';
import {
  API_ROUTES,
  parseVersionInfo,
  type ApiRouteName,
  type LedgerResponse,
  type StartRunRequest,
  type ThinkingValue,
  type ThreadLastRun,
  type VersionInfo,
} from '@agent/agent-models';

/** How often a trial reads the ledger while it waits for its run. */
const POLL_MS = 2_000;

/**
 * The few API calls a trial needs (base `http://localhost:<port>/api/agent`).
 * Trials go through the real entry point (G2); nothing here calls the loop.
 */
export class ApiClient {
  private readonly client: AgentClient;

  constructor(
    /** The agent routes' base, mount included (`http://localhost:<port>/api/agent`). */
    private readonly base: string,
    private readonly pollMs = POLL_MS,
    /** The API's token (`<eval home>/api-token`): requests without an Origin need it. */
    token?: string,
  ) {
    this.client = createAgentClient({ baseUrl: base, token, mounts: { agent: '' } });
  }

  private async json<T>(name: ApiRouteName, params?: Record<string, string>, body?: unknown): Promise<T> {
    const { method } = API_ROUTES[name];
    const route = this.client.url(name, params).slice(this.base.replace(/\/+$/, '').length);
    const response = await this.client.request(name, {
      ...(params ? { params } : {}),
      init: {
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(60_000),
      },
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${method} ${route} → ${response.status}: ${text.slice(0, 300)}`);
    return (text ? JSON.parse(text) : {}) as T;
  }

  /** A workspace thread when `workspaceRoot` is given, else a home (chat) thread. */
  createThread(input: { workspaceRoot?: string; model: string; title: string }): Promise<{ id: string }> {
    return this.json('threads.create', undefined, { kind: input.workspaceRoot ? 'workspace' : 'home', ...input });
  }

  /** What the API runs and which home it writes (`GET /version`); null on an API from before the route. */
  async version(): Promise<VersionInfo | null> {
    try {
      return parseVersionInfo(await this.json('version'));
    } catch (error) {
      if (error instanceof Error && error.message.includes('→ 404')) return null;
      throw error;
    }
  }

  deleteThread(id: string): Promise<unknown> {
    return this.json('threads.delete', { id });
  }

  startRun(input: {
    threadId: string;
    content: string;
    model: string;
    posture: 'agent' | 'ask' | 'plan';
    /** Omitted: the model default. `'auto'`: System 1 picks per iteration (enforce mode only). */
    thinking?: ThinkingValue;
  }): Promise<{ runId: string }> {
    const body: StartRunRequest = {
      threadId: input.threadId,
      message: { content: input.content },
      model: input.model,
      posture: input.posture,
      ...(input.thinking !== undefined ? { thinking: input.thinking } : {}),
      webSearch: true,
      contextWindowMode: 'default',
    };
    return this.json('runs.start', undefined, body);
  }

  /** A run that already settled answers 404: that is fine, there is nothing left to stop. */
  async cancelRun(runId: string): Promise<void> {
    await this.json('runs.cancel', { runId }).catch(() => undefined);
  }

  ledger(threadId: string): Promise<LedgerResponse> {
    return this.json('threads.ledger', { id: threadId });
  }

  /** `null` when the API has no OLLAMA_API_KEY (local models: no capacity gate). */
  async balance(): Promise<unknown | null> {
    try {
      return await this.json('usage.balance');
    } catch (error) {
      if (error instanceof Error && error.message.includes('→ 404')) return null;
      throw error;
    }
  }

  /**
   * Wait until `runId` has settled and return its last-run, or null after
   * `timeoutMs`. The API shows a run's last-run only once the run has fully
   * settled (workspace and ledger final), so "the thread's last-run is this
   * run" is the whole signal: no stream to drop, no race with post-run work.
   * Nobody answers a choice in a trial, so a run paused on one is skipped
   * (the run then ends with a summary of the options).
   */
  async settledLastRun(threadId: string, runId: string, timeoutMs: number): Promise<ThreadLastRun | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const ledger = await this.ledger(threadId);
      if (ledger.lastRun?.runId === runId) return ledger.lastRun;
      if (ledger.activeRun?.runId === runId) {
        for (const choice of ledger.activeRun.pendingChoices) {
          // 404: answered or gone meanwhile.
          await this.json('runs.choice', { runId }, { choiceId: choice.choiceId, skipped: true }).catch(
            () => undefined,
          );
        }
      }
      if (Date.now() >= deadline) return null;
      await new Promise((resolve) => setTimeout(resolve, this.pollMs));
    }
  }
}
