import path from 'node:path';

import { commandOutput, gradeAnswer } from '../runner/score.js';
import { loadTasks, TASK_SUITES, type LoadedTask } from '../runner/task.js';
import { flag, type Args } from './args.js';
import { table } from './format.js';

export const VALIDATE_HELP = `validate [--task <id>] [--tasks-dir evals/tasks]
  Grade every task's reference answer with the task's own grader (no API, no spend).
  A reference that fails means the task or its grader is broken. Exit 1 when any fails.`;

/** `{{command}}` placeholders in a reference, replaced by the command's output here. */
async function expand(text: string, cwd: string): Promise<string> {
  let out = text;
  for (const match of text.matchAll(/\{\{([^}]+)\}\}/g)) {
    out = out.replace(match[0], await commandOutput(match[1]!.trim(), cwd));
  }
  return out;
}

type Row = { id: string; verdict: 'ok' | 'FAIL' | 'no reference' | 'not graded by answer'; detail: string };

async function validateTask(loaded: LoadedTask, cwd: string): Promise<Row> {
  const { task } = loaded;
  const checks = task.answer ?? [];
  if (checks.length === 0) {
    // Edit tasks are graded by checks and files; their reference is a patch (not built yet).
    return { id: task.id, verdict: 'not graded by answer', detail: `${task.checks.length} check(s), ${task.files.length} file assertion(s): needs a patch reference` };
  }
  if (!task.reference?.answer) return { id: task.id, verdict: 'no reference', detail: `${checks.length} answer check(s) unproven` };
  const answer = await expand(task.reference.answer, cwd);
  const results = await gradeAnswer(checks, answer, (command) => commandOutput(command, cwd));
  const failed = results.filter((result) => !result.passed);
  return failed.length === 0
    ? { id: task.id, verdict: 'ok', detail: `${results.length}/${results.length} answer checks pass` }
    : { id: task.id, verdict: 'FAIL', detail: failed.map((result) => result.fromCommand ? `from \`${result.fromCommand}\`` : `/${result.mustMatch}/`).join(', ') };
}

export async function validateCommand(args: Args): Promise<number> {
  const tasksDir = path.resolve(flag(args, 'tasks-dir') ?? 'evals/tasks');
  const id = flag(args, 'task');
  const tasks: LoadedTask[] = [];
  for (const suite of TASK_SUITES) {
    tasks.push(...(await loadTasks(tasksDir, { suite, ...(id ? { id } : {}) })));
  }
  const rows = await Promise.all(tasks.map((loaded) => validateTask(loaded, process.cwd())));
  console.log(table(['task', 'verdict', 'detail'], rows.map((row) => [row.id, row.verdict, row.detail])));
  return rows.some((row) => row.verdict === 'FAIL') ? 1 : 0;
}
