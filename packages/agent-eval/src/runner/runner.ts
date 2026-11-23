import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { isPauseStop, isResumableStop, limitMessage, RUN_CANCELLED_REASON, RUN_PAUSED_PREFIX, type ThinkingValue, type ThreadLastRun } from '@agent/agent-models';

import { readCatalog } from '../read/catalog.js';
import { readLedger } from '../read/ledger.js';
import { listRuns } from '../read/runs.js';
import { linesOf, readRunTrace } from '../read/trace.js';
import { flattenRuns, loadRunMetrics } from '../metrics/load.js';
import type { RunMetrics } from '../metrics/run-metrics.js';
import { ApiClient } from './api-client.js';
import { trialCost, type TrialCost } from './cost.js';
import { checkout, pruneWorkdirs, type Checkout } from './checkout.js';
import { git } from './exec.js';
import { gradeTrial, type FailureCategory, type Grade } from './score.js';
import { readSeed } from './seed.js';
import type { LoadedTask, TaskSuite } from './task.js';

const CONTINUE_MESSAGE = 'Continue from where the last run stopped.';
/** After cancelling a run past its deadline, how long to wait for it to settle before giving up on the trial. */
const CANCEL_SETTLE_MS = 120_000;
/**
 * A task's token budget is graded, not enforced: the run keeps the production
 * cap so the trial measures the real harness. Past this many times the budget
 * the trial cannot pass anyway, so it is cancelled instead of spending on.
 */
const OVER_BUDGET_FACTOR = 2;
const BUDGET_CHECK_MS = 30_000;
/** Reason prefix of trials skipped because the account ran out; the rest of the suite is skipped too. */
const CAPACITY_SKIP = 'capacity';

export type TrialStatus = 'passed' | 'failed' | 'skipped' | 'error';

/**
 * Why a trial's last run ended, so a report can tell "the agent failed" from
 * "the setup failed": settled (normally), timeout (past the trial deadline,
 * cancelled by the runner), over-budget (past OVER_BUDGET_FACTOR, cancelled by
 * the runner), cancelled (by someone else), capacity (the account ran out),
 * error (API down, checkout, a run that errored, crashed or never settled).
 */
export type TrialEnd = 'settled' | 'timeout' | 'over-budget' | 'cancelled' | 'capacity' | 'error';

/** What a trial needs from the API; `ApiClient` in production, a fake in tests. */
export type TrialClient = Pick<ApiClient, 'createThread' | 'startRun' | 'cancelRun' | 'settledLastRun'>;

export type TrialOptions = Pick<RunnerOptions, 'evalHome' | 'harnessRoot' | 'model' | 'thinking' | 'continues'>;

export type TrialResult = {
  taskId: string;
  suite: TaskSuite;
  trial: number;
  /** The harness under test: commit plus a hash of uncommitted changes. */
  harnessSha: string;
  harnessDirty: string | null;
  seedHash: string;
  taskHash: string;
  model: string;
  /** `thinking` sent on every run of the trial; absent = the model default. */
  thinking?: ThinkingValue;
  /**
   * The System 1 setup the trial ran under (`system1SetupOf`). The gate
   * compares only like setups unless asked to compare them (plan D-2).
   */
  system1Setup?: string;
  /**
   * Harness flags the trial's runs used (`run_start.flags`; the API's
   * AGENT_FLAGS). The gate compares runs that differ in at most one flag.
   * Absent on results written before it, or when no run recorded flags.
   */
  harnessFlags?: Record<string, boolean>;
  status: TrialStatus;
  ended?: TrialEnd;
  /** Why it was skipped or errored. */
  reason?: string;
  checksPassed?: boolean;
  filesPassed?: boolean;
  answersPassed?: boolean;
  scopeViolations?: string[];
  budgetOk?: boolean;
  /** Why a trial failed or errored (`score.ts` FailureCategory); absent on a clean pass. */
  failure?: FailureCategory;
  continues: number;
  limitReason?: string;
  promptTokens?: number;
  /** Cached, output, calls and USD over every run of the trial (`cost.ts`); absent on results written before it. */
  cost?: TrialCost;
  minutes?: number;
  grade?: Grade;
  deps?: Checkout['deps'];
  depsMs?: number;
  metrics?: RunMetrics[];
  threadId?: string;
  runIds: string[];
  startedAt: string;
  finishedAt: string;
};

export type RunnerOptions = {
  tasks: LoadedTask[];
  repeat: number;
  /** Repo whose harness is under test (its HEAD + diff are recorded). */
  harnessRoot: string;
  evalHome: string;
  apiBase: string;
  model: string;
  /** `--thinking`; overrides the task's own `thinking`. */
  thinking?: ThinkingValue;
  /** Continue messages allowed per trial on resumable limits. */
  continues: number;
  /** Trials at once (default 1). Each has its own checkout and thread. */
  parallel?: number;
  /** Stop the suite once this many weekly-% points were used since it started. */
  maxWeeklyPercent: number;
  label: string;
  log: (message: string) => void;
};

export type SuiteRun = { resultsDir: string; results: TrialResult[] };

/** `summary.json` in a suite run's results folder; the trial files are the only copy of the results. */
export const SUITE_META_FILE = 'summary.json';

export type SuiteRunMeta = {
  label: string;
  suite: TaskSuite | 'mixed';
  harnessSha: string;
  harnessDirty: string | null;
  seedHash: string;
  model: string;
  thinking?: ThinkingValue;
  tasks: string[];
  repeat: number;
  startBalance: { session: number | null; weekly: number | null };
  startedAt: string;
  finishedAt?: string;
  /** Why the suite stopped early (ceiling, capacity). */
  stopped?: string;
};

type Balance = { session: number | null; weekly: number | null };

function balanceOf(raw: unknown): Balance {
  const legacy = (raw as { legacy?: { session?: { remainingPercent?: number }; weekly?: { remainingPercent?: number } } } | null)
    ?.legacy;
  return {
    session: legacy?.session?.remainingPercent ?? null,
    weekly: legacy?.weekly?.remainingPercent ?? null,
  };
}

async function harnessVersion(root: string): Promise<{ sha: string; dirty: string | null }> {
  const head = await git(root, ['rev-parse', 'HEAD']);
  // The task corpus is not harness code: editing a task must not mark the API stale.
  // Same pathspec as apps/api/src/platform/harness-version.ts, so the two hashes compare.
  const diff = await git(root, ['diff', 'HEAD', '--', '.', ':(exclude)evals']);
  return {
    sha: head.stdout.trim(),
    dirty: diff.stdout.trim() ? createHash('sha256').update(diff.stdout).digest('hex').slice(0, 16) : null,
  };
}

/**
 * `<mode>/thinking=<value>`, e.g. `enforce/thinking=auto`. The mode is what
 * the traces show (`off` without System 1 lines, `mixed` when runs disagree),
 * not what the API was asked for.
 */
export function system1SetupOf(metrics: RunMetrics[], thinking: ThinkingValue | undefined): string {
  const modes = new Set(metrics.map((m) => m.system1?.mode ?? 'off'));
  const mode = modes.size === 0 ? 'off' : modes.size === 1 ? [...modes][0]! : 'mixed';
  return `${mode}/thinking=${thinking === undefined ? 'default' : String(thinking)}`;
}

/**
 * The flags of the trial's own runs, from their `run_start` lines. Every run
 * of one trial talks to one API process, so they agree; a trial whose runs
 * disagree (the API restarted with other AGENT_FLAGS mid-trial) throws, since
 * no single flag set produced it.
 */
async function trialFlags(
  runs: Array<{ runId: string; tracePath: string }>,
  expected?: { sha: string; dirty: string | null },
): Promise<Record<string, boolean> | undefined> {
  let found: Record<string, boolean> | undefined;
  for (const run of runs) {
    const { lines } = await readRunTrace(run.tracePath);
    const start = linesOf(lines, 'run_start')[0];
    // An API restarted mid-suite on other code: this trial measured something else.
    const version = start?.harnessVersion;
    if (expected && version && (version.sha !== expected.sha || version.dirty !== expected.dirty)) {
      throw new Error(`run ${run.runId} ran code ${version.sha.slice(0, 8)}${version.dirty ? `+${version.dirty}` : ''}, not the checkout this suite records; was the API restarted on other code?`);
    }
    const flags = start?.flags as Record<string, boolean> | undefined;
    if (!flags) continue;
    if (found && flagSetKey(found) !== flagSetKey(flags)) {
      throw new Error(`run ${run.runId} used other harness flags than the trial's first run; was the API restarted with new AGENT_FLAGS?`);
    }
    found ??= flags;
  }
  return found;
}

/** A flag set as one comparable string (names sorted). */
export function flagSetKey(flags: Record<string, boolean>): string {
  return Object.keys(flags)
    .sort()
    .map((name) => `${name}:${flags[name] ? 'on' : 'off'}`)
    .join(',');
}

/** The API must be serving the eval home; a thread it creates must appear in that catalog. */
async function assertApiOnEvalHome(
  api: ApiClient,
  apiBase: string,
  evalHome: string,
  workspaceRoot: string,
  model: string,
): Promise<void> {
  let probe: { id: string };
  try {
    probe = await api.createThread({ workspaceRoot, model, title: 'agent-eval home probe' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `The API is not reachable at ${apiBase} (${message}). Start it with AGENT_HOME=${evalHome}; the runner never starts it.`,
    );
  }
  let seen = false;
  try {
    // No catalog.db yet means this API has never written to the eval home.
    seen = existsSync(path.join(evalHome, 'catalog.db')) &&
      readCatalog(evalHome).some((thread) => thread.id === probe.id);
  } finally {
    await api.deleteThread(probe.id).catch(() => undefined);
  }
  if (!seen) {
    throw new Error(
      `The API is not using the eval home (${evalHome}). Start it with AGENT_HOME set to that folder; the runner never starts or reconfigures it.`,
    );
  }
}

/** Prompt tokens of every run on the trial's thread so far, sub-agents included. */
async function trialPromptTokens(home: string, threadId: string): Promise<number> {
  let total = 0;
  for (const run of flattenRuns(await listRuns(home, { threadId }))) {
    const { lines } = await readRunTrace(run.tracePath);
    for (const line of linesOf(lines, 'llm_response')) total += line.usage?.promptTokens ?? 0;
  }
  return total;
}

/**
 * One trial: a fresh checkout, a thread, the task prompt plus up to
 * `continues` Continue messages on resumable stops, then a grade of the
 * settled workspace. Never throws: failures are an `error` trial.
 */
export async function runTrial(
  api: TrialClient,
  opts: TrialOptions,
  loaded: LoadedTask,
  trial: number,
  base: Omit<TrialResult, 'taskId' | 'suite' | 'trial' | 'taskHash' | 'status' | 'continues' | 'runIds' | 'startedAt' | 'finishedAt'>,
): Promise<TrialResult> {
  const { task } = loaded;
  const startedAt = new Date();
  const thinking = opts.thinking ?? task.thinking;
  const result: TrialResult = {
    ...base,
    taskId: task.id,
    suite: task.suite,
    trial,
    taskHash: loaded.taskHash,
    ...(thinking !== undefined ? { thinking } : {}),
    status: 'error',
    continues: 0,
    runIds: [],
    startedAt: startedAt.toISOString(),
    finishedAt: '',
  };
  try {
    // A home task is a chat: no checkout, no workspace on the thread.
    const home = task.mode === 'home';
    const workdirs = path.join(opts.evalHome, 'workdirs');
    const tree = home
      ? undefined
      : await checkout({
          source: path.resolve(opts.harnessRoot, task.repo.source),
          commit: task.repo.commit,
          dir: path.join(workdirs, `${task.id}-${trial}`),
        });
    if (tree) {
      result.deps = tree.deps;
      result.depsMs = tree.depsMs;
    }

    const thread = await api.createThread({
      ...(tree ? { workspaceRoot: tree.dir } : {}),
      model: opts.model,
      title: `eval ${task.id} #${trial}`,
    });
    result.threadId = thread.id;
    // The agent's clock starts here: checkout and `npm ci` (depsMs) are setup, not the agent's minutes.
    const workStartedAt = Date.now();

    // A hard stop well past the task's own budget, so a stuck run cannot hold the suite.
    const deadline = workStartedAt + task.budget.maxMinutes * 2 * 60_000 + 10 * 60_000;
    // One user turn after another (followUps), each with its own Continues.
    const turns = [task.prompt, ...(task.followUps ?? [])];
    let limitReason: string | undefined;
    for (const [turnIndex, turnPrompt] of turns.entries()) {
      // The next turn goes only to a thread whose last turn settled with no stop.
      if (turnIndex > 0 && (result.ended !== 'settled' || limitReason)) break;
      let message = turnPrompt;
      for (;;) {
        let started: { runId: string };
        try {
          started = await api.startRun({
            threadId: thread.id,
            content: message,
            model: opts.model,
            posture: task.posture,
            ...(thinking !== undefined ? { thinking } : {}),
          });
        } catch (error) {
          // The host refuses a start while the account is paused: the same
          // capacity outcome as a run that paused (no grade), not an error.
          const text = error instanceof Error ? error.message : String(error);
          if (!text.startsWith(RUN_PAUSED_PREFIX)) throw error;
          limitReason = limitMessage('limit.capacity', text.slice(RUN_PAUSED_PREFIX.length).trim());
          break;
        }
        const { runId } = started;
        result.runIds.push(runId);
        const budgetStop = task.budget.maxPromptTokens * OVER_BUDGET_FACTOR;
        let lastRun: ThreadLastRun | null = null;
        let stopped: { ended: TrialEnd; reason: string } | undefined;
        while (!lastRun && !stopped) {
          lastRun = await api.settledLastRun(thread.id, runId, Math.max(0, Math.min(BUDGET_CHECK_MS, deadline - Date.now())));
          if (lastRun) break;
          if (Date.now() >= deadline) {
            stopped = { ended: 'timeout', reason: 'eval.timeout: trial passed its hard deadline' };
          } else if ((await trialPromptTokens(opts.evalHome, thread.id)) > budgetStop) {
            stopped = { ended: 'over-budget', reason: `eval.budget: trial passed ${budgetStop} prompt tokens` };
          }
        }
        if (!lastRun) {
          await api.cancelRun(runId);
          // Grade only a settled workspace: a cancelled run can still be finishing a write.
          if (!(await api.settledLastRun(thread.id, runId, CANCEL_SETTLE_MS))) {
            throw new Error(`run ${runId} did not settle within ${CANCEL_SETTLE_MS / 1000}s of its cancel; workspace not graded`);
          }
          result.ended = stopped!.ended;
          limitReason = stopped!.reason;
          break;
        }
        limitReason = lastRun.limitReason;
        // lastRun.status 'error' also covers a server that stopped mid-run (the interrupted marker).
        result.ended = limitReason === RUN_CANCELLED_REASON ? 'cancelled' : lastRun.status === 'error' ? 'error' : 'settled';
        // A pause (account ran out) is resumable for a person, not for a trial.
        if (!limitReason || !isResumableStop(limitReason) || isPauseStop(limitReason)) break;
        if (result.continues >= opts.continues) break;
        result.continues += 1;
        message = CONTINUE_MESSAGE;
      }
    }
    if (limitReason) result.limitReason = limitReason;

    const runs = flattenRuns(await listRuns(opts.evalHome, { threadId: thread.id })).filter((run) =>
      result.runIds.includes(run.runId),
    );
    const metrics = await loadRunMetrics(opts.evalHome, runs);
    result.metrics = metrics;
    result.system1Setup = system1SetupOf(metrics, thinking);
    const harnessFlags = await trialFlags(runs, { sha: base.harnessSha, dirty: base.harnessDirty });
    if (harnessFlags) result.harnessFlags = harnessFlags;

    // The account ran out, not the agent: the trial gets no grade (plan D-3).
    if (limitReason && isPauseStop(limitReason)) {
      result.ended = 'capacity';
      result.status = 'skipped';
      result.reason = `${CAPACITY_SKIP}: ${limitReason}`;
      result.finishedAt = new Date().toISOString();
      return result;
    }
    const promptTokens = metrics.reduce((sum, m) => sum + m.promptTokens.total, 0);
    const minutes = (Date.now() - workStartedAt) / 60_000;
    result.promptTokens = promptTokens;
    result.cost = await trialCost(flattenRuns(runs));
    result.minutes = Math.round(minutes * 10) / 10;

    const lastRunId = result.runIds.at(-1);
    const answer = (await readLedger(opts.evalHome, thread.id)).envelopes
      .filter((envelope) => envelope.runId === lastRunId && envelope.record.role === 'assistant')
      .map((envelope) => (typeof envelope.record.content === 'string' ? envelope.record.content : ''))
      .filter(Boolean)
      .at(-1);
    const grade = await gradeTrial({
      task,
      ...(tree ? { dir: tree.dir } : {}),
      ...(answer ? { answer } : {}),
      promptTokens,
      minutes,
      ...(limitReason ? { unresolvedLimit: limitReason } : {}),
    });
    result.grade = grade;
    result.checksPassed = grade.checksPassed;
    result.filesPassed = grade.filesPassed;
    result.answersPassed = grade.answersPassed;
    result.scopeViolations = grade.scopeViolations;
    result.budgetOk = grade.budget.ok;
    if (grade.failure) result.failure = grade.failure;
    result.status = grade.passed ? 'passed' : 'failed';
  } catch (error) {
    result.status = 'error';
    result.ended = 'error';
    result.failure = 'infra';
    result.reason = error instanceof Error ? error.message : String(error);
  }
  result.finishedAt = new Date().toISOString();
  return result;
}

/**
 * Run each task `repeat` times through the real API on the eval home, grade
 * each trial from its end state, and write one JSON file per trial plus
 * `summary.json` under `<evalHome>/results/<ts>-<label>/`.
 */
export async function runSuite(opts: RunnerOptions): Promise<SuiteRun> {
  const seed = await readSeed(opts.evalHome);
  if (!seed) throw new Error(`The eval home is not seeded. Run: agent-eval seed --eval-home ${opts.evalHome}`);
  if (seed.drifted) throw new Error('The eval home changed since it was seeded. Re-run agent-eval seed.');
  if (opts.tasks.length === 0) throw new Error('No tasks selected.');

  // The API writes its token into its AGENT_HOME, which is the eval home.
  const tokenFile = path.join(opts.evalHome, 'api-token');
  const token = existsSync(tokenFile) ? (await readFile(tokenFile, 'utf8')).trim() : undefined;
  const api = new ApiClient(opts.apiBase, undefined, token);
  const harness = await harnessVersion(opts.harnessRoot);
  const workdirs = path.join(opts.evalHome, 'workdirs');
  await mkdir(workdirs, { recursive: true });
  await assertApiOnEvalHome(api, opts.apiBase, opts.evalHome, workdirs, opts.model);
  // The results say they measured `harness`; the API must be running exactly that code.
  const live = await api.version();
  if (!live?.harnessVersion) {
    opts.log('WARNING: the API does not report its code version (an API from before GET /version, or not in a git checkout); results assume it runs this checkout.');
  } else if (live.harnessVersion.sha !== harness.sha || live.harnessVersion.dirty !== harness.dirty) {
    throw new Error(
      `The API runs other code than this checkout (API ${live.harnessVersion.sha.slice(0, 8)}${live.harnessVersion.dirty ? `+${live.harnessVersion.dirty}` : ''}, checkout ${harness.sha.slice(0, 8)}${harness.dirty ? `+${harness.dirty}` : ''}). Restart the eval API so it runs what you are measuring.`,
    );
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const resultsDir = path.join(opts.evalHome, 'results', `${stamp}-${opts.label}`);
  await mkdir(resultsDir, { recursive: true });

  const start = balanceOf(await api.balance());
  const results: TrialResult[] = [];
  const base = {
    harnessSha: harness.sha,
    harnessDirty: harness.dirty,
    seedHash: seed.seedHash,
    model: opts.model,
  };
  const suites = new Set(opts.tasks.map((loaded) => loaded.task.suite));
  const meta: SuiteRunMeta = {
    label: opts.label,
    suite: suites.size === 1 ? [...suites][0]! : 'mixed',
    ...base,
    ...(opts.thinking !== undefined ? { thinking: opts.thinking } : {}),
    tasks: opts.tasks.map((loaded) => loaded.task.id),
    repeat: opts.repeat,
    startBalance: start,
    startedAt: new Date().toISOString(),
  };
  // Written now and again at the end, so an interrupted suite run still says what it was.
  const writeMeta = () => writeFile(path.join(resultsDir, SUITE_META_FILE), `${JSON.stringify(meta, null, 2)}\n`);
  await writeMeta();
  let stopped: string | undefined;

  // Old checkouts go first, for every task: parallel trials of one task must
  // not prune each other's workdirs.
  for (const loaded of opts.tasks) {
    await pruneWorkdirs(workdirs, loaded.task.id, path.resolve(opts.harnessRoot, loaded.task.repo.source));
  }
  const jobs = opts.tasks.flatMap((loaded) =>
    Array.from({ length: opts.repeat }, (_, index) => ({ loaded, trial: index + 1 })),
  );
  let next = 0;
  // Each worker takes the next job; capacity and the weekly ceiling are
  // checked before every trial, so a spent account stops new trials at once.
  const worker = async (): Promise<void> => {
    for (;;) {
      const job = jobs[next++];
      if (!job) return;
      const { loaded, trial } = job;
      const now = balanceOf(await api.balance());
      if (!stopped && start.weekly !== null && now.weekly !== null && start.weekly - now.weekly >= opts.maxWeeklyPercent) {
        stopped = `suite ceiling: ${start.weekly - now.weekly}% of the week used (max ${opts.maxWeeklyPercent}%)`;
      }
      const capacity =
        (now.session !== null && now.session <= 1) || (now.weekly !== null && now.weekly <= 1)
          ? `${CAPACITY_SKIP}: session or weekly allowance spent`
          : undefined;
      const skip = stopped ?? capacity;
      const result: TrialResult = skip
        ? {
            ...base,
            taskId: loaded.task.id,
            suite: loaded.task.suite,
            trial,
            taskHash: loaded.taskHash,
            status: 'skipped',
            ...(stopped ? {} : { ended: 'capacity' as const }),
            reason: skip,
            continues: 0,
            runIds: [],
            startedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString(),
          }
        : await runTrial(api, opts, loaded, trial, base);
      results.push(result);
      // A run paused on capacity: every later trial would pause too.
      if (!stopped && !skip && result.status === 'skipped') stopped = result.reason;
      await writeFile(
        path.join(resultsDir, `${loaded.task.id}-${trial}.json`),
        `${JSON.stringify(result, null, 2)}\n`,
      );
      opts.log(
        `${loaded.task.id} #${trial}: ${result.status}${result.failure ? ` [${result.failure}]` : ''}${result.reason ? ` (${result.reason})` : ''}${result.promptTokens !== undefined ? ` · ${result.promptTokens} prompt tokens · ${result.minutes} min` : ''}`,
      );
    }
  };
  const workers = Math.max(1, Math.min(opts.parallel ?? 1, jobs.length));
  await Promise.all(Array.from({ length: workers }, () => worker()));
  // Report in task/trial order, whatever order the workers finished in.
  const order = new Map(jobs.map((job, index) => [`${job.loaded.task.id}#${job.trial}`, index]));
  results.sort((a, b) => (order.get(`${a.taskId}#${a.trial}`) ?? 0) - (order.get(`${b.taskId}#${b.trial}`) ?? 0));

  meta.finishedAt = new Date().toISOString();
  if (stopped) meta.stopped = stopped;
  await writeMeta();
  return { resultsDir, results };
}
