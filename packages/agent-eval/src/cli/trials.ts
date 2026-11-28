import path from 'node:path';

import { WORKSPACE_MODE } from '@agent/agent-models';

import { capacityRates } from '../metrics/thread-metrics.js';
import { readUsage } from '../read/usage.js';
import { runSuite, type SuiteRun } from '../runner/runner.js';
import { seedEvalHome } from '../runner/seed.js';
import { loadTasks, TASK_SUITES, type TaskSuite } from '../runner/task.js';
import { agentHome, evalHome, flag, intFlag, type Args } from './args.js';
import { evalApiBase, evalApiBaseFor } from './up.js';

/** Trials at once: more would only queue on the model provider and blur minutes. */
export const MAX_PARALLEL = 4;

export const SEED_HELP = `seed [--home <personal home>] [--eval-home <dir>]
  Copy skills, agents and user memory into the eval home; write seed.json with its hash.`;

export const RUN_HELP = `run [--task <id> | --suite matrix|regression|capability] [--repeat 5 (matrix) / 1] [--parallel 1]
    [--model <id>] [--api ${evalApiBase()}] [--continues 2] [--max-weekly-percent 10]
    [--label <name>] [--tasks-dir evals/tasks] [--eval-home <dir>] [--thinking <value>]
  Run trials through the eval API (start it with: up); grade each from its end state.
  With no --task or --suite, runs the matrix.
  --parallel: trials at once (max ${MAX_PARALLEL}), each in its own checkout; capacity checks still apply per trial.
  --thinking: sent on every run, overriding the task's own (e.g. auto = System 1 picks; needs SYSTEMONE_MODE=enforce).`;

export async function seedCommand(args: Args): Promise<number> {
  const info = await seedEvalHome(agentHome(args), evalHome(args));
  console.log(`Seeded ${evalHome(args)} from ${info.from}: ${info.files} files, seedHash ${info.seedHash.slice(0, 12)}`);
  return 0;
}

export function suiteFlag(args: Args): TaskSuite | undefined {
  const suite = flag(args, 'suite');
  if (suite === undefined) return undefined;
  if (!TASK_SUITES.includes(suite as TaskSuite)) throw new Error(`--suite must be one of ${TASK_SUITES.join(', ')}`);
  return suite as TaskSuite;
}

/** Load the selected tasks, print the cost estimate, run the suite. */
export async function runCommandFor(
  args: Args,
  select: { suite?: TaskSuite; id?: string },
): Promise<SuiteRun> {
  const tasks = await loadTasks(path.resolve(flag(args, 'tasks-dir') ?? 'evals/tasks'), select);
  // The matrix gates harness changes: 5 trials per task, since 3 cannot tell a 33-point drop from noise.
  const repeat = intFlag(args, 'repeat', select.suite === 'matrix' ? 5 : 1);
  const model = flag(args, 'model') ?? WORKSPACE_MODE.model;
  const thinkingFlag = flag(args, 'thinking');
  // Booleans are what models without levels take; anything else is a level name or 'auto'.
  const thinking =
    thinkingFlag === 'true' ? true : thinkingFlag === 'false' ? false : thinkingFlag;

  // Cost estimate from the personal usage log, before spending anything.
  const rate = capacityRates((await readUsage(agentHome(args))).records).find((r) => r.model === model);
  // A trial is cancelled at twice its budget (runner.ts), so that is the worst case.
  const budget = tasks.reduce((sum, loaded) => sum + loaded.task.budget.maxPromptTokens, 0) * repeat * 2;
  console.log(
    `${tasks.length} task(s) × ${repeat} trial(s) on ${model}; worst case ${(budget / 1_000_000).toFixed(1)}M prompt tokens` +
      (rate ? ` ≈ ${((budget / 1_000_000) * rate.weeklyPercentPer1M).toFixed(1)}% of the week` : ' (no capacity rate for this model yet)'),
  );

  const run = await runSuite({
    tasks,
    repeat,
    harnessRoot: process.cwd(),
    evalHome: evalHome(args),
    apiBase: flag(args, 'api') ?? evalApiBaseFor(evalHome(args)),
    parallel: Math.min(MAX_PARALLEL, intFlag(args, 'parallel', 1)),
    model,
    ...(thinking !== undefined ? { thinking } : {}),
    continues: intFlag(args, 'continues', 2),
    maxWeeklyPercent: intFlag(args, 'max-weekly-percent', 10),
    label: flag(args, 'label') ?? (select.id ?? select.suite ?? 'run'),
    log: (message) => console.log(message),
  });
  const counts = run.results.reduce<Record<string, number>>((acc, result) => {
    acc[result.status] = (acc[result.status] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`\nResults in ${run.resultsDir}: ${Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(', ')}`);
  return run;
}

export async function runCommand(args: Args): Promise<number> {
  const id = flag(args, 'task');
  // No selection: the matrix, the suite every harness change runs.
  const suite = suiteFlag(args) ?? (id ? undefined : 'matrix');
  const run = await runCommandFor(args, { ...(suite ? { suite } : {}), ...(id ? { id } : {}) });
  return run.results.some((result) => result.status === 'error') ? 1 : 0;
}
