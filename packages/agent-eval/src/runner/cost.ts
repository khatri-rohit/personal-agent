import { callCostUsd } from '@agent/agent-models';

import type { RunSummary } from '../read/runs.js';
import { linesOf, readRunTrace } from '../read/trace.js';

/**
 * What a trial cost, from the `llm_response` usage of every run it made,
 * sub-agents included. `costUsd` is null when any call cannot be priced
 * (unknown model, or no cached-token count): a partial sum would make one
 * trial look cheaper than another for the wrong reason.
 */
export type TrialCost = {
  calls: number;
  promptTokens: number;
  /** Prompt tokens the provider served from cache, over calls that reported it. */
  cachedTokens: number;
  outputTokens: number;
  /** Calls without a cached-token count. */
  callsWithoutCache: number;
  /** 90th percentile of prompt tokens per call, own and sub-agent calls together. */
  p90PromptPerCall: number | null;
  costUsd: number | null;
};

function p90(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.9) - 1)]!;
}

/** `runs`: every run of the trial, sub-agents included (flattened). */
export async function trialCost(runs: RunSummary[]): Promise<TrialCost> {
  const cost: TrialCost = {
    calls: 0,
    promptTokens: 0,
    cachedTokens: 0,
    outputTokens: 0,
    callsWithoutCache: 0,
    p90PromptPerCall: null,
    costUsd: 0,
  };
  const perCall: number[] = [];
  for (const run of runs) {
    const { lines } = await readRunTrace(run.tracePath);
    const model = linesOf(lines, 'run_start')[0]?.model ?? run.model;
    for (const line of linesOf(lines, 'llm_response')) {
      const usage = line.usage;
      if (!usage) {
        // No provider usage at all: the call cannot be priced.
        cost.calls += 1;
        cost.callsWithoutCache += 1;
        cost.costUsd = null;
        continue;
      }
      cost.calls += 1;
      cost.promptTokens += usage.promptTokens;
      cost.outputTokens += usage.completionTokens;
      perCall.push(usage.promptTokens);
      if (usage.cachedTokens === undefined) cost.callsWithoutCache += 1;
      else cost.cachedTokens += usage.cachedTokens;
      const usd = callCostUsd(model, usage);
      cost.costUsd = usd === null || cost.costUsd === null ? null : cost.costUsd + usd;
    }
  }
  cost.p90PromptPerCall = p90(perCall);
  return cost;
}
