import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { exec, git } from './exec.js';
import type { EvalTask } from './task.js';

export type CheckResult = { run: string; exit: number; passed: boolean; timedOut: boolean; outTail: string };
export type FileResult = { path: string; passed: boolean; reason?: string };
/** `mustMatch`: the regex, or the command whose output had to appear (`fromCommand`). */
export type AnswerResult = { mustMatch: string; passed: boolean; fromCommand?: string; expected?: string };

/**
 * Why a trial did not pass, first cause first: what a reader fixes next.
 * `infra` is set by the runner (setup, API, a run that never settled).
 */
export type FailureCategory =
  | 'checks-failed'
  | 'files-wrong'
  | 'wrong-answer'
  | 'out-of-scope'
  | 'limit'
  | 'over-budget'
  | 'infra';

export type Grade = {
  checks: CheckResult[];
  checksPassed: boolean;
  files: FileResult[];
  filesPassed: boolean;
  /** The task's `answer` patterns against the final answer (empty when the task has none). */
  answers: AnswerResult[];
  answersPassed: boolean;
  /** Paths changed in the workdir (tracked diffs + untracked, not ignored). */
  changed: string[];
  scopeViolations: string[];
  budget: { promptTokens: number; minutes: number; unresolvedLimit?: string; ok: boolean };
  /**
   * The task was done: checks, files, answer and scope all pass, and the run
   * did not end on an unresolved limit. Budget is not part of it.
   */
  correct: boolean;
  /** Same as `correct`: a trial passes on the work; spend is graded apart (`budget.ok`, the gate's cost rules). */
  passed: boolean;
  /** Absent when the trial passed and stayed within budget. */
  failure?: FailureCategory;
};

/** The first reason in reading order: what was wrong with the work, then how it ended, then spend. */
export function failureOf(grade: Omit<Grade, 'failure'>): FailureCategory | undefined {
  if (!grade.checksPassed) return 'checks-failed';
  if (!grade.filesPassed) return 'files-wrong';
  if (!grade.answersPassed) return 'wrong-answer';
  if (grade.scopeViolations.length > 0) return 'out-of-scope';
  if (grade.budget.unresolvedLimit) return 'limit';
  if (!grade.budget.ok) return 'over-budget';
  return undefined;
}

/** Escape a literal for use inside a RegExp. */
function literal(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Grade an answer against a task's answer checks. `run` executes a
 * `fromCommand` where the trial ran and returns its trimmed output.
 */
export async function gradeAnswer(
  checks: NonNullable<EvalTask['answer']>,
  answer: string,
  run: (command: string) => Promise<string>,
): Promise<AnswerResult[]> {
  const results: AnswerResult[] = [];
  for (const check of checks) {
    if (check.fromCommand !== undefined) {
      const expected = (await run(check.fromCommand)).trim();
      results.push({
        mustMatch: literal(expected),
        fromCommand: check.fromCommand,
        expected,
        passed: expected.length > 0 && new RegExp(literal(expected), 'i').test(answer),
      });
    } else {
      results.push({ mustMatch: check.mustMatch, passed: new RegExp(check.mustMatch, 'im').test(answer) });
    }
  }
  return results;
}

/** Trimmed stdout of a short command (answer checks, reference placeholders). */
export async function commandOutput(command: string, cwd: string): Promise<string> {
  const result = await exec(command, [], { cwd, shell: true, timeoutMs: 60_000 });
  return result.code === 0 ? result.out.trim() : '';
}

const DEFAULT_CHECK_TIMEOUT_SEC = 300;

/** `scope.allow` entries: exact paths, `dir/` prefixes, or globs with `*` (one segment) and `**`. */
export function scopeMatcher(allow: string[]): (file: string) => boolean {
  const patterns = allow.map((entry) => {
    const pattern = entry.replace(/\\/g, '/');
    if (pattern.endsWith('/')) return (file: string) => file.startsWith(pattern);
    if (!pattern.includes('*')) return (file: string) => file === pattern;
    const source = pattern
      .split('**')
      .map((part) => part.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*'))
      .join('.*');
    const regex = new RegExp(`^${source}$`);
    return (file: string) => regex.test(file);
  });
  return (file) => patterns.some((match) => match(file));
}

async function changedFiles(dir: string): Promise<string[]> {
  const tracked = await git(dir, ['diff', '--name-only', 'HEAD']);
  const untracked = await git(dir, ['ls-files', '--others', '--exclude-standard']);
  return [
    ...new Set(
      `${tracked.stdout}\n${untracked.stdout}`
        .split('\n')
        .map((line) => line.trim().replace(/\\/g, '/'))
        .filter(Boolean),
    ),
  ].sort();
}

/**
 * Grade a trial from its end state, cheapest first: checks (commands), file
 * assertions, the final answer's required patterns, scope, budget. A home
 * task has no workdir: only its answer and budget are graded. Of the
 * transcript, only the final answer is read (it is the end state of a
 * research or question task).
 */
export async function gradeTrial(input: {
  task: EvalTask;
  /** Workdir; absent for a home task. */
  dir?: string;
  /** The run's final answer text. */
  answer?: string;
  promptTokens: number;
  minutes: number;
  /** Set when the trial still ended on a run limit after its Continues. */
  unresolvedLimit?: string;
}): Promise<Grade> {
  const { task } = input;
  // A home task has no workdir: nothing to run or read there.
  const dir = input.dir ?? '';
  const inWorkdir = input.dir !== undefined;
  const checks: CheckResult[] = [];
  for (const check of inWorkdir ? task.checks : []) {
    const result = await exec(check.run, [], {
      cwd: dir,
      shell: true,
      timeoutMs: (check.timeoutSec ?? DEFAULT_CHECK_TIMEOUT_SEC) * 1000,
    });
    checks.push({
      run: check.run,
      exit: result.code,
      passed: !result.timedOut && result.code === check.expectExit,
      timedOut: result.timedOut,
      outTail: result.out.slice(-1500),
    });
  }

  const files: FileResult[] = [];
  for (const entry of inWorkdir ? task.files : []) {
    try {
      const text = await readFile(path.join(dir, entry.path), 'utf8');
      const passed = new RegExp(entry.mustMatch, 'm').test(text);
      files.push({ path: entry.path, passed, ...(passed ? {} : { reason: `no match for /${entry.mustMatch}/` }) });
    } catch {
      files.push({ path: entry.path, passed: false, reason: 'file missing' });
    }
  }

  // A home task has no workdir; machine facts are read where the API runs (this machine).
  const answers = await gradeAnswer(task.answer ?? [], input.answer ?? '', (command) =>
    commandOutput(command, inWorkdir ? dir : process.cwd()),
  );

  const changed = inWorkdir ? await changedFiles(dir) : [];
  const allowed = scopeMatcher(task.scope.allow);
  const scopeViolations = changed.filter((file) => !allowed(file));

  const budgetOk =
    input.promptTokens <= task.budget.maxPromptTokens &&
    input.minutes <= task.budget.maxMinutes &&
    !input.unresolvedLimit;

  const checksPassed = checks.every((check) => check.passed);
  const filesPassed = files.every((file) => file.passed);
  const answersPassed = answers.every((answer) => answer.passed);
  // A run that still ended on a limit did not finish the work, whatever its files say.
  const correct =
    checksPassed && filesPassed && answersPassed && scopeViolations.length === 0 && !input.unresolvedLimit;
  const grade: Omit<Grade, 'failure'> = {
    checks,
    checksPassed,
    files,
    filesPassed,
    answers,
    answersPassed,
    changed,
    scopeViolations,
    budget: {
      promptTokens: input.promptTokens,
      minutes: input.minutes,
      ...(input.unresolvedLimit ? { unresolvedLimit: input.unresolvedLimit } : {}),
      ok: budgetOk,
    },
    correct,
    passed: correct,
  };
  const failure = failureOf(grade);
  return { ...grade, ...(failure ? { failure } : {}) };
}
