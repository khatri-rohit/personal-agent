import { DEFAULT_HARNESS_FLAGS, MODEL_PRICES_SOURCE } from '@agent/agent-models';

import type { TaskSuite } from '../runner/task.js';
import type { SuiteStats, TaskStats } from './summary.js';

/** A task fails when it loses this many passing trials (scaled to its trial count). */
export const MAX_LOST_TRIALS = 2;
/** Median prompt tokens may rise this much on a stable task that passed in both. */
export const MAX_TOKEN_RISE = 0.1;
/** Median USD per passed trial may rise this much (the cost verdict, when both sides are priced). */
export const MAX_COST_RISE = 0.1;
/**
 * Guard metrics may rise this much: p90 prompt per call (long-context
 * quality and latency) and calls per task. Cached tokens are cheap, so a
 * cost-only gate would let the prompt grow unchecked; these catch that.
 */
export const MAX_GUARD_RISE = 0.25;

/**
 * Paired suite difference over the tasks both sides ran: mean of per-task
 * pass-rate differences (candidate − baseline), and its standard error from
 * each task's trial variance. Pairing on tasks removes task difficulty from
 * the noise (Miller, "Adding error bars to evals"). Rates are
 * Agresti–Caffo adjusted ((passes+1)/(trials+2) per side) so a 3/3 task
 * still carries variance.
 */
export function pairedSuiteDifference(
  pairs: Array<{ base: TaskStats; cand: TaskStats }>,
): { tasks: number; meanDiff: number; standardError: number; detectable: number } | null {
  if (pairs.length === 0) return null;
  let diff = 0;
  let variance = 0;
  for (const { base, cand } of pairs) {
    diff += cand.passRate - base.passRate;
    const pb = (base.passes + 1) / (base.trials + 2);
    const pc = (cand.passes + 1) / (cand.trials + 2);
    variance += (pb * (1 - pb)) / base.trials + (pc * (1 - pc)) / cand.trials;
  }
  const m = pairs.length;
  const standardError = Math.sqrt(variance) / m;
  return { tasks: m, meanDiff: diff / m, standardError, detectable: 1.96 * standardError };
}

/** The rise (a share) when `value` rose more than `limit` from `base`; null otherwise or when either is missing. */
function rose(base: number | null | undefined, value: number | null | undefined, limit: number): number | null {
  if (base == null || value == null || base <= 0) return null;
  const rise = value / base - 1;
  return rise > limit ? rise : null;
}

export type Baseline = SuiteStats & {
  suite: TaskSuite;
  recordedAt: string;
  /** Set when written with --accept: why an expected regression was accepted. */
  acceptReason?: string;
};

export type TaskVerdict = {
  taskId: string;
  baseline?: TaskStats;
  candidate?: TaskStats;
  failures: string[];
  notes: string[];
};

export type GateResult =
  | { kind: 'refuse'; reasons: string[] }
  | {
      kind: 'verdict';
      passed: boolean;
      suiteFailures: string[];
      /** What the verdict rests on: the flag under test, the cost source, the System 1 rule used. */
      notes: string[];
      tasks: TaskVerdict[];
    };

/**
 * The flags that differ between two recorded flag sets, as `name off → on`;
 * null when either side did not record flags. A name one side lacks (the
 * flag did not exist yet) counts as its default: that is what that harness
 * did.
 */
export function flagChanges(
  base: Record<string, boolean> | undefined,
  cand: Record<string, boolean> | undefined,
): string[] | null {
  if (!base || !cand) return null;
  const defaults = DEFAULT_HARNESS_FLAGS as Record<string, boolean>;
  const onOff = (value: boolean | undefined) => (value === undefined ? 'absent' : value ? 'on' : 'off');
  const names = [...new Set([...Object.keys(base), ...Object.keys(cand)])].sort();
  const changes: string[] = [];
  for (const name of names) {
    const was = base[name] ?? defaults[name];
    const now = cand[name] ?? defaults[name];
    if (was !== now) changes.push(`${name} ${onOff(was)} → ${onOff(now)}`);
  }
  return changes;
}

/** What the comparison is for. `system1`: baseline and candidate differ only in their System 1 setup (plan N5). */
export type GateCompare = 'harness' | 'system1';

/**
 * Compare a candidate suite run with the baseline (plan §8). Refuses (no
 * verdict) when the two were measured on a different model, seed, task
 * definitions or System 1 setup, or in more than one harness flag; a
 * different harness version is what the gate tests. With `compare:
 * 'system1'` the setups must differ (flags the same), and the candidate must
 * also lower the median cost of the tasks that passed in both, or their
 * median prompt tokens when not all are priced (same pass rate, cheaper).
 */
export function compareToBaseline(
  baseline: Baseline,
  candidate: SuiteStats,
  compare: GateCompare = 'harness',
): GateResult {
  const refuse: string[] = [];
  if (baseline.suite && candidate.suite && baseline.suite !== candidate.suite) {
    refuse.push(`suite differs: baseline ${baseline.suite}, candidate ${candidate.suite}`);
  }
  if (baseline.model !== candidate.model) refuse.push(`model differs: baseline ${baseline.model}, candidate ${candidate.model}`);
  if (baseline.seedHash !== candidate.seedHash) refuse.push('seedHash differs: the eval home was re-seeded with different skills, agents or memory');
  // Baselines recorded before setups were tracked have none.
  const baseSetup = baseline.system1Setup ?? 'unrecorded';
  if (compare === 'harness' && baseSetup !== candidate.system1Setup) {
    refuse.push(`System 1 setup differs: baseline ${baseSetup}, candidate ${candidate.system1Setup}. Pass --compare system1 to compare setups`);
  }
  if (compare === 'system1' && baseSetup === candidate.system1Setup) {
    refuse.push(`--compare system1 needs different setups; both are ${baseSetup}`);
  }
  // One flag per comparison:
  // with two changed, a verdict cannot say which one moved the result.
  const notes: string[] = [];
  const changes = flagChanges(baseline.harnessFlags, candidate.harnessFlags);
  if (changes === null) {
    notes.push('harness flags unrecorded on one side: the gate cannot confirm a one-flag change');
  } else if (compare === 'harness' && changes.length > 1) {
    refuse.push(`harness flags differ in ${changes.length} flags (${changes.join('; ')}): compare one flag at a time`);
  } else if (compare === 'system1' && changes.length > 0) {
    refuse.push(`--compare system1 needs the same harness flags; they differ: ${changes.join('; ')}`);
  } else if (changes.length === 1) {
    notes.push(`flag under test: ${changes[0]}`);
  }
  for (const [taskId, base] of Object.entries(baseline.tasks)) {
    const cand = candidate.tasks[taskId];
    if (!cand) refuse.push(`task ${taskId} is in the baseline but did not run`);
    else if (cand.taskHash !== base.taskHash) refuse.push(`task ${taskId} changed since the baseline (taskHash)`);
  }
  if (refuse.length > 0) return { kind: 'refuse', reasons: refuse };

  const tasks: TaskVerdict[] = [];
  for (const [taskId, cand] of Object.entries(candidate.tasks)) {
    const base = baseline.tasks[taskId];
    const verdict: TaskVerdict = { taskId, candidate: cand, failures: [], notes: [] };
    if (!base) {
      verdict.notes.push('new task: not in the baseline, no verdict');
      tasks.push(verdict);
      continue;
    }
    verdict.baseline = base;
    const trials = Math.max(base.trials, cand.trials);
    const lost = (base.passRate - cand.passRate) * trials;
    if (lost >= MAX_LOST_TRIALS - 1e-9) {
      verdict.failures.push(`lost ${Math.round(lost)} passing trial(s) of ${trials} (${base.passes}/${base.trials} → ${cand.passes}/${cand.trials})`);
    } else if (lost > 1e-9) {
      verdict.notes.push(`one trial flipped (${base.passes}/${base.trials} → ${cand.passes}/${cand.trials}): within noise`);
    }
    if (cand.scopeViolations > base.scopeViolations) {
      verdict.failures.push(`scope violations rose ${base.scopeViolations} → ${cand.scopeViolations}`);
    }
    // Cost verdict when both sides are priced: cached prompt tokens cost a
    // fraction of uncached ones and output costs more, so raw prompt tokens
    // would reward breaking the cache. Older baselines have no cost: the
    // prompt-token rule stays for them.
    const priced = base.medianCostUsd != null && cand.medianCostUsd != null;
    // More trials over the task's budget is a regression even when they pass.
    if (base.overBudget !== undefined && cand.overBudget !== undefined && cand.overBudget - base.overBudget >= MAX_LOST_TRIALS) {
      verdict.failures.push(`over-budget trials rose ${base.overBudget} → ${cand.overBudget}`);
    }
    if (base.stable && cand.stable) {
      if (priced) {
        // Cost per success (all spend ÷ passes) when both sides have it: a
        // median over passing trials alone rewards failing cheaply.
        const perSuccess = base.costPerSuccess != null && cand.costPerSuccess != null;
        const baseCost = perSuccess ? base.costPerSuccess! : base.medianCostUsd!;
        const candCost = perSuccess ? cand.costPerSuccess! : cand.medianCostUsd!;
        const costRise = rose(baseCost, candCost, MAX_COST_RISE);
        if (costRise !== null) {
          verdict.failures.push(`${perSuccess ? 'cost per success' : 'median cost per passed trial'} rose ${Math.round(costRise * 100)}% ($${baseCost.toFixed(4)} → $${candCost.toFixed(4)})`);
        }
        const p90Rise = rose(base.medianP90PromptPerCall, cand.medianP90PromptPerCall, MAX_GUARD_RISE);
        if (p90Rise !== null) {
          verdict.failures.push(`p90 prompt per call rose ${Math.round(p90Rise * 100)}% (${base.medianP90PromptPerCall} → ${cand.medianP90PromptPerCall})`);
        }
        const callsRise = rose(base.medianCalls, cand.medianCalls, MAX_GUARD_RISE);
        if (callsRise !== null) {
          verdict.failures.push(`model calls per passed trial rose ${Math.round(callsRise * 100)}% (${base.medianCalls} → ${cand.medianCalls})`);
        }
        const minutesRise = rose(base.medianMinutes, cand.medianMinutes, MAX_GUARD_RISE);
        if (minutesRise !== null) {
          verdict.failures.push(`minutes per passed trial rose ${Math.round(minutesRise * 100)}% (${base.medianMinutes} → ${cand.medianMinutes})`);
        }
        const tokenRise = rose(base.medianPromptTokens, cand.medianPromptTokens, MAX_TOKEN_RISE);
        if (tokenRise !== null) {
          verdict.notes.push(`median prompt tokens rose ${Math.round(tokenRise * 100)}% (reported; the cost verdict decides)`);
        }
      } else if (base.medianPromptTokens !== null && cand.medianPromptTokens !== null) {
        const rise = cand.medianPromptTokens / base.medianPromptTokens - 1;
        if (rise > MAX_TOKEN_RISE) {
          verdict.failures.push(`median prompt tokens rose ${Math.round(rise * 100)}% (${base.medianPromptTokens} → ${cand.medianPromptTokens})`);
        }
        if ((base.medianCostUsd != null) !== (cand.medianCostUsd != null)) {
          verdict.notes.push('cost on one side only (unpriced model, or results without cost): prompt-token verdict');
        }
      }
    } else if (base.medianPromptTokens !== null && cand.medianPromptTokens !== null) {
      verdict.notes.push('unstable or too few trials: no token verdict');
    }
    if (cand.errors > 0) verdict.notes.push(`${cand.errors} trial(s) errored (infrastructure, counted as not passing)`);
    tasks.push(verdict);
  }

  // Suite rule on paired per-task differences: a drop counts only when it
  // is beyond the noise this run can resolve (1.96 SE) and at least
  // MAX_LOST_TRIALS trials were lost. The verdict says what size of drop the
  // run could have detected at all.
  const suiteFailures: string[] = [];
  const pairs = tasks.flatMap((task) => (task.baseline && task.candidate ? [{ base: task.baseline, cand: task.candidate }] : []));
  const paired = pairedSuiteDifference(pairs);
  if (paired) {
    const lostOverall = pairs.reduce((sum, { base, cand }) => sum + Math.max(0, base.passes - cand.passes), 0);
    const pts = (value: number) => Math.round(value * 100);
    notes.push(
      `paired over ${paired.tasks} task(s): pass rate ${paired.meanDiff >= 0 ? '+' : ''}${pts(paired.meanDiff)} points ± ${pts(paired.detectable)} (95%); drops smaller than ${pts(paired.detectable)} points cannot be told from noise in this run`,
    );
    if (paired.meanDiff < 0 && -paired.meanDiff > paired.detectable && lostOverall >= MAX_LOST_TRIALS) {
      suiteFailures.push(
        `suite pass rate dropped ${pts(-paired.meanDiff)} points (paired, beyond ±${pts(paired.detectable)}; ${lostOverall} trial(s) lost)`,
      );
    }
  }
  if (tasks.some((task) => task.baseline?.medianCostUsd != null && task.candidate?.medianCostUsd != null)) {
    notes.push(
      `cost is an estimate at list prices (${MODEL_PRICES_SOURCE.url}, read ${MODEL_PRICES_SOURCE.readOn}, peak rates), not the account's own meter`,
    );
  }
  if (compare === 'system1') {
    // Same pass rate at lower cost, when every shared task is priced on both sides.
    const pricedShared = tasks.filter(
      (task) => task.baseline?.medianCostUsd != null && task.candidate?.medianCostUsd != null,
    );
    const allPriced =
      pricedShared.length > 0 &&
      pricedShared.length ===
        tasks.filter((task) => task.baseline?.medianPromptTokens != null && task.candidate?.medianPromptTokens != null).length;
    if (allPriced) {
      const baseCost = pricedShared.reduce((sum, task) => sum + task.baseline!.medianCostUsd!, 0);
      const candCost = pricedShared.reduce((sum, task) => sum + task.candidate!.medianCostUsd!, 0);
      if (candCost >= baseCost) {
        suiteFailures.push(`${candidate.system1Setup} did not lower median cost ($${baseCost.toFixed(4)} → $${candCost.toFixed(4)} over ${pricedShared.length} task(s))`);
      }
      notes.push('System 1 rule: same pass rate, lower median cost (every shared task priced)');
      const passed = suiteFailures.length === 0 && tasks.every((task) => task.failures.length === 0);
      return { kind: 'verdict', passed, suiteFailures, notes, tasks };
    }
    notes.push('System 1 rule: same pass rate, fewer median prompt tokens (not every shared task priced)');
    const shared = tasks.filter(
      (task) => task.baseline?.medianPromptTokens != null && task.candidate?.medianPromptTokens != null,
    );
    const base = shared.reduce((sum, task) => sum + task.baseline!.medianPromptTokens!, 0);
    const cand = shared.reduce((sum, task) => sum + task.candidate!.medianPromptTokens!, 0);
    if (shared.length === 0) {
      suiteFailures.push('no task passed in both setups: tokens cannot be compared');
    } else if (cand >= base) {
      suiteFailures.push(`${candidate.system1Setup} did not lower median prompt tokens (${base} → ${cand} over ${shared.length} task(s))`);
    }
  }
  const passed = suiteFailures.length === 0 && tasks.every((task) => task.failures.length === 0);
  return { kind: 'verdict', passed, suiteFailures, notes, tasks };
}
