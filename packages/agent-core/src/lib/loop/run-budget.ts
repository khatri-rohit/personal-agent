import {
  CHARS_PER_TOKEN,
  limitMessage,
  totalRunUsage,
  type RunUsage,
  type TokenUsage,
} from '@agent/agent-models';

import { BUDGET_WARN_RATIO, type AgentLimits } from './limits';

/**
 * What a run has spent (its own model calls plus its sub-agents') against
 * its prompt-token and wall-clock caps. `usage` is the run's live tally:
 * charges land in it, and the loop reports it when the run ends.
 */
export class RunBudget {
  private warned = false;
  /** Time spent waiting on the user (a choice, an approval): not the run's to spend. */
  private waitedMs = 0;
  private waits = 0;
  private waitStartedAt = 0;

  constructor(
    private readonly usage: RunUsage,
    private readonly limits: AgentLimits,
    private readonly startedAt: number,
  ) {}

  /**
   * The wall clock stops while `pending` waits on the user, so a slow answer
   * does not end the run on `limit.wall` right after. Overlapping waits
   * (parallel tool calls) count once.
   */
  async waitingOnUser<T>(pending: Promise<T>): Promise<T> {
    if (this.waits++ === 0) this.waitStartedAt = Date.now();
    try {
      return await pending;
    } finally {
      if (--this.waits === 0) this.waitedMs += Date.now() - this.waitStartedAt;
    }
  }

  /** Wall time the run itself has used (waits on the user excluded). */
  private workedMs(): number {
    const ongoing = this.waits > 0 ? Date.now() - this.waitStartedAt : 0;
    return Date.now() - this.startedAt - this.waitedMs - ongoing;
  }

  get maxPromptTokens(): number | undefined {
    return this.limits.maxPromptTokens;
  }

  /** Prompt tokens spent so far, sub-agents included. */
  spent(): number {
    return totalRunUsage(this.usage).promptTokens;
  }

  /** Model calls made by sub-agents so far. */
  childCalls(): number {
    return this.usage.children.calls;
  }

  snapshot(): RunUsage {
    return {
      own: { ...this.usage.own },
      children: { ...this.usage.children },
    };
  }

  /**
   * Charge one model call. Without provider usage (local Ollama, streams
   * without include_usage) the local estimate is charged instead, so the
   * token budget never goes blind. Returns true when estimated.
   */
  chargeOwn(
    turnUsage: TokenUsage | undefined,
    estimatedPrompt: number,
    content: string | null | undefined,
  ): boolean {
    const own = this.usage.own;
    own.calls += 1;
    if (turnUsage) {
      own.promptTokens += turnUsage.promptTokens;
      own.completionTokens += turnUsage.completionTokens;
      return false;
    }
    own.estimatedCalls += 1;
    own.promptTokens += estimatedPrompt;
    own.completionTokens += Math.ceil((content ?? '').length / CHARS_PER_TOKEN);
    return true;
  }

  chargeChild(child: RunUsage): void {
    const total = totalRunUsage(child);
    const children = this.usage.children;
    children.promptTokens += total.promptTokens;
    children.completionTokens += total.completionTokens;
    children.calls += total.calls;
    children.estimatedCalls += total.estimatedCalls;
  }

  remaining(): number | undefined {
    if (this.limits.maxPromptTokens === undefined) return undefined;
    return Math.max(0, this.limits.maxPromptTokens - this.spent());
  }

  /**
   * Token and wall-clock gates. Checked before every model call. `nextCall`
   * (the estimate of the call about to be sent) stops the run before a call
   * that would cross the cap, so only the final answer can go over it.
   */
  exceeded(nextCall = 0): string | null {
    const { maxPromptTokens, maxWallMs } = this.limits;
    const spent = this.spent();
    if (maxPromptTokens !== undefined && spent >= maxPromptTokens) {
      return limitMessage(
        'limit.tokens',
        `prompt token budget spent (${spent} of ${maxPromptTokens})`,
      );
    }
    if (
      maxPromptTokens !== undefined &&
      nextCall > 0 &&
      spent + nextCall > maxPromptTokens
    ) {
      return limitMessage(
        'limit.tokens',
        `prompt token budget nearly spent: the next call (~${nextCall}) would pass the cap (${spent} of ${maxPromptTokens})`,
      );
    }
    if (maxWallMs !== undefined && this.workedMs() >= maxWallMs) {
      return limitMessage(
        'limit.wall',
        `wall clock budget spent (${Math.round(maxWallMs / 1000)}s)`,
      );
    }
    return null;
  }

  /** Spend and cap while spend is past the wrap-up mark (not consumed: the harness card reads it every call). */
  nearLimit(): { spent: number; limit: number } | undefined {
    const limit = this.limits.maxPromptTokens;
    if (limit === undefined) return undefined;
    const spent = this.spent();
    return spent >= limit * BUDGET_WARN_RATIO ? { spent, limit } : undefined;
  }

  /** Spend and cap, the first time spend crosses the wrap-up mark; afterwards undefined. */
  takeWarning(): { spent: number; limit: number } | undefined {
    const limit = this.limits.maxPromptTokens;
    if (this.warned || limit === undefined) return undefined;
    const spent = this.spent();
    if (spent < limit * BUDGET_WARN_RATIO) return undefined;
    this.warned = true;
    return { spent, limit };
  }
}
