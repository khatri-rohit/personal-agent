import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readdir, rm, rmdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  CHECKPOINT_EXCLUDES,
  CHECKPOINT_NOT_COVERED,
  type FileChange,
  type RevertResult,
  type RunChanges,
} from '@agent/agent-models';

/**
 * Checkpoints (B3). Before an Agent run in a workspace the host snapshots the
 * folder, and again when the run ends. Undo puts back what a run changed,
 * but only the files that still hold what the run left: anything changed
 * since (by the user or a later run) is reported, never overwritten.
 *
 * The snapshots live in a shadow git repository per folder under
 * `AGENT_HOME/checkpoints/<hash>` (`--git-dir` + `--work-tree`), so the
 * user's own repository, index and history are never touched. Each run keeps
 * two refs, `refs/runs/<runId>/before` and `…/after`.
 *
 * Byte-exact on every OS: line-ending conversion, filters and the folder's
 * `.gitattributes` are switched off for the shadow repo, hooks never run,
 * and pathspecs are literal (a Next.js `[id]` folder is not a glob).
 */

const DIFF_MAX_CHARS = 200_000;

/** Overrides applied to every call, whatever the user's global git config says. */
function configArgs(dir: string): string[] {
  return [
    '-c', 'core.autocrlf=false',
    '-c', 'core.safecrlf=false',
    '-c', 'core.longpaths=true',
    '-c', 'core.quotepath=false',
    '-c', 'core.fsmonitor=false',
    '-c', `core.hooksPath=${path.join(dir, 'no-hooks')}`,
    '-c', 'gc.auto=0',
    '-c', 'advice.addEmbeddedRepo=false',
    '-c', 'user.name=agent-checkpoint',
    '-c', 'user.email=checkpoint@localhost',
    '--literal-pathspecs',
  ];
}

/** Git variables in the API's own environment (GIT_DIR, GIT_INDEX_FILE, …) would redirect the shadow repo. */
function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.toUpperCase().startsWith('GIT_')) env[key] = value;
  }
  env.GIT_TERMINAL_PROMPT = '0';
  return env;
}

type GitResult = { code: number; stdout: Buffer; stderr: string };

function runGit(dir: string, root: string, args: string[], input?: Buffer): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['--git-dir', dir, '--work-tree', root, ...configArgs(dir), ...args], {
      cwd: root,
      env: gitEnv(),
      windowsHide: true,
    });
    const out: Buffer[] = [];
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 20_000) stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout: Buffer.concat(out), stderr }));
    if (input) child.stdin.end(input);
    else child.stdin.end();
  });
}

async function git(dir: string, root: string, args: string[], input?: Buffer): Promise<string> {
  const result = await runGit(dir, root, args, input);
  if (result.code !== 0) {
    throw new Error(`git ${args[0]} failed: ${result.stderr.trim().split('\n').slice(-3).join(' ') || `exit ${result.code}`}`);
  }
  return result.stdout.toString('utf8');
}

function folderKey(root: string): string {
  const resolved = path.resolve(root);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function shadowDir(agentHome: string, root: string): string {
  const hash = createHash('sha256').update(folderKey(root)).digest('hex').slice(0, 24);
  return path.join(agentHome, 'checkpoints', hash);
}

/** Git work on one shadow repo runs one at a time (two threads on a folder share its index). */
const locks = new Map<string, Promise<unknown>>();

function withLock<T>(dir: string, work: () => Promise<T>): Promise<T> {
  const previous = locks.get(dir) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(work);
  locks.set(dir, next);
  void next.finally(() => {
    if (locks.get(dir) === next) locks.delete(dir);
  });
  return next;
}

const initialized = new Set<string>();

async function ensureRepo(dir: string, root: string): Promise<void> {
  if (initialized.has(dir)) return;
  await mkdir(path.join(dir, 'no-hooks'), { recursive: true });
  const head = await runGit(dir, root, ['rev-parse', '--git-dir']);
  if (head.code !== 0) await git(dir, root, ['init', '--quiet']);
  await mkdir(path.join(dir, 'info'), { recursive: true });
  // Highest-precedence attributes: no text conversion or filters, whatever the folder's .gitattributes say.
  await writeFile(path.join(dir, 'info', 'attributes'), '* -text -eol -filter -ident -working-tree-encoding\n');
  // AGENT_HOME inside the folder (working on this repo itself) is never
  // snapshotted: it holds the shadow repo, which would swallow itself.
  const agentHome = path.dirname(path.dirname(dir));
  const relativeHome = path.relative(path.resolve(root), agentHome);
  const homeExclude =
    relativeHome && !relativeHome.startsWith('..') && !path.isAbsolute(relativeHome)
      ? [`/${relativeHome.split(path.sep).join('/')}/`]
      : [];
  await writeFile(path.join(dir, 'info', 'exclude'), `${[...CHECKPOINT_EXCLUDES, ...homeExclude].join('\n')}\n`);
  await writeFile(path.join(dir, 'folder.txt'), `${path.resolve(root)}\n`);
  initialized.add(dir);
}

/** Stage the whole folder and record it; returns the commit. Unreadable files are skipped, not fatal. */
async function snapshot(dir: string, root: string): Promise<string> {
  await ensureRepo(dir, root);
  // --ignore-errors: a file another program holds open is skipped (exit stays non-zero); the rest is recorded.
  await runGit(dir, root, ['add', '--all', '--ignore-errors', '--', '.']);
  const tree = (await git(dir, root, ['write-tree'])).trim();
  return (await git(dir, root, ['commit-tree', tree, '-m', 'checkpoint'])).trim();
}

/** The Agent run writing in each folder (one at a time: an undo must not take back another thread's edits). */
const writers = new Map<string, { runId: string; threadId: string }>();

export function folderWriter(root: string): { runId: string; threadId: string } | null {
  return writers.get(folderKey(root)) ?? null;
}

/**
 * Snapshot before an Agent run and mark the folder as written by it. False
 * when the snapshot failed (git missing, unreadable folder): the run still
 * goes ahead, without undo, and the Changes view says so.
 */
export async function checkpointBefore(input: {
  agentHome: string;
  root: string;
  runId: string;
  threadId: string;
}): Promise<boolean> {
  writers.set(folderKey(input.root), { runId: input.runId, threadId: input.threadId });
  const dir = shadowDir(input.agentHome, input.root);
  try {
    await withLock(dir, async () => {
      const commit = await snapshot(dir, input.root);
      await git(dir, input.root, ['update-ref', `refs/runs/${input.runId}/before`, commit]);
    });
    return true;
  } catch (error) {
    console.error('checkpoint before run failed:', error instanceof Error ? error.message : error);
    return false;
  }
}

/** Snapshot at the end of the run (any outcome) and free the folder. */
export async function checkpointAfter(input: { agentHome: string; root: string; runId: string }): Promise<void> {
  const dir = shadowDir(input.agentHome, input.root);
  try {
    await withLock(dir, async () => {
      if (!(await refExists(dir, input.root, `refs/runs/${input.runId}/before`))) return;
      const commit = await snapshot(dir, input.root);
      await git(dir, input.root, ['update-ref', `refs/runs/${input.runId}/after`, commit]);
    });
  } catch (error) {
    console.error('checkpoint after run failed:', error instanceof Error ? error.message : error);
  } finally {
    const key = folderKey(input.root);
    if (writers.get(key)?.runId === input.runId) writers.delete(key);
  }
}

async function refExists(dir: string, root: string, ref: string): Promise<boolean> {
  return (await runGit(dir, root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).code === 0;
}

/**
 * From the earliest snapshotted run's "before" to the latest one's "after"
 * (`runIds` in ledger order). Runs without snapshots are Ask/Plan runs,
 * which cannot write, so skipping them loses nothing. Null when none has both.
 */
async function rangeOf(dir: string, root: string, runIds: string[]): Promise<{ from: string; to: string } | null> {
  let from: string | null = null;
  for (const runId of runIds) {
    const ref = `refs/runs/${runId}/before`;
    if (await refExists(dir, root, ref)) {
      from = ref;
      break;
    }
  }
  if (!from) return null;
  for (const runId of [...runIds].reverse()) {
    const ref = `refs/runs/${runId}/after`;
    if (await refExists(dir, root, ref)) return { from, to: ref };
  }
  return null;
}

type RawChange = { path: string; status: string; nestedRepo: boolean };

/** `git diff --raw -z`: ":oldmode newmode oldsha newsha status\0path\0" per file. */
async function rawChanges(dir: string, root: string, from: string, to: string): Promise<RawChange[]> {
  const out = await git(dir, root, ['diff', '--raw', '-z', '--no-renames', '--no-abbrev', from, to]);
  const parts = out.split('\0');
  const changes: RawChange[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const meta = parts[i]!.replace(/^:/, '').split(' ');
    const file = parts[i + 1]!;
    if (!file) continue;
    changes.push({
      path: file,
      status: (meta[4] ?? 'M').charAt(0),
      nestedRepo: meta[0] === '160000' || meta[1] === '160000',
    });
  }
  return changes;
}

async function changedNames(dir: string, root: string, from: string, to: string): Promise<Set<string>> {
  const out = await git(dir, root, ['diff', '--name-only', '-z', '--no-renames', from, to]);
  return new Set(out.split('\0').filter(Boolean));
}

/** What these runs (in order) changed together. */
export async function runChanges(input: { agentHome: string; root: string; runIds: string[] }): Promise<RunChanges> {
  const dir = shadowDir(input.agentHome, input.root);
  return withLock(dir, async () => {
    const range = await rangeOf(dir, input.root, input.runIds).catch(() => null);
    if (!range) return { available: false, files: [], notCovered: CHECKPOINT_NOT_COVERED };
    const raw = await rawChanges(dir, input.root, range.from, range.to);
    const counts = new Map<string, { added?: number; removed?: number }>();
    const numstat = await git(dir, input.root, ['diff', '--numstat', '-z', '--no-renames', range.from, range.to]);
    for (const entry of numstat.split('\0')) {
      const [added, removed, ...rest] = entry.split('\t');
      const file = rest.join('\t');
      if (!file) continue;
      counts.set(file, added === '-' ? {} : { added: Number(added), removed: Number(removed) });
    }
    const files: FileChange[] = raw.map((change) => ({
      path: change.path,
      status: change.status === 'A' ? 'added' : change.status === 'D' ? 'deleted' : 'modified',
      ...(counts.get(change.path) ?? {}),
      ...(change.nestedRepo ? { nestedRepo: true } : {}),
    }));
    return { available: true, files, notCovered: CHECKPOINT_NOT_COVERED };
  });
}

/** The unified diff of one file across these runs. */
export async function runFileDiff(input: {
  agentHome: string;
  root: string;
  runIds: string[];
  file: string;
}): Promise<{ diff: string; truncated: boolean } | null> {
  const dir = shadowDir(input.agentHome, input.root);
  return withLock(dir, async () => {
    const range = await rangeOf(dir, input.root, input.runIds);
    if (!range) return null;
    const diff = await git(dir, input.root, ['diff', '--no-color', '--no-renames', range.from, range.to, '--', input.file]);
    return diff.length > DIFF_MAX_CHARS
      ? { diff: diff.slice(0, DIFF_MAX_CHARS), truncated: true }
      : { diff, truncated: false };
  });
}

/**
 * Put back what these runs changed. A file is restored only while it still
 * holds what the last run left; otherwise it is a conflict and stays as it
 * is. Files the runs added are deleted; files they deleted come back.
 * Throws when the runs have no snapshots (nothing can be put back).
 */
export async function revertRuns(input: { agentHome: string; root: string; runIds: string[] }): Promise<RevertResult> {
  const dir = shadowDir(input.agentHome, input.root);
  return withLock(dir, async () => {
    const range = await rangeOf(dir, input.root, input.runIds);
    if (!range) throw new Error('No snapshot exists for these runs, so their file changes cannot be undone.');
    const now = await snapshot(dir, input.root);
    const changes = await rawChanges(dir, input.root, range.from, range.to);
    const drifted = await changedNames(dir, input.root, range.to, now);
    const differsFromBefore = await changedNames(dir, input.root, range.from, now);

    const result: RevertResult = { restored: [], conflicts: [], failed: [], skipped: [], alreadyUndone: [] };
    const toCheckout: string[] = [];
    const toDelete: string[] = [];
    for (const change of changes) {
      if (change.nestedRepo) result.skipped.push(change.path);
      else if (!differsFromBefore.has(change.path)) result.alreadyUndone.push(change.path);
      else if (drifted.has(change.path)) result.conflicts.push(change.path);
      else if (change.status === 'A') toDelete.push(change.path);
      else toCheckout.push(change.path);
    }

    if (toCheckout.length > 0) {
      const all = await runGit(
        dir,
        input.root,
        ['checkout', range.from, '--pathspec-from-file=-', '--pathspec-file-nul'],
        Buffer.from(toCheckout.join('\0'), 'utf8'),
      );
      if (all.code === 0) {
        result.restored.push(...toCheckout);
      } else {
        // One file failed (locked, read-only): find which, file by file.
        for (const file of toCheckout) {
          const one = await runGit(dir, input.root, ['checkout', range.from, '--', file]);
          if (one.code === 0) result.restored.push(file);
          else result.failed.push({ path: file, error: one.stderr.trim().split('\n').at(-1) ?? 'checkout failed' });
        }
      }
    }

    for (const file of toDelete) {
      const absolute = path.join(input.root, file);
      try {
        await rm(absolute, { force: true });
        await removeEmptyParents(path.dirname(absolute), input.root);
        result.restored.push(file);
      } catch (error) {
        result.failed.push({ path: file, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return result;
  });
}

/**
 * Drop a folder's snapshots once no thread uses the folder any more (its
 * last thread was deleted; eval trials each use a throwaway folder).
 */
export async function forgetCheckpoints(agentHome: string, root: string): Promise<void> {
  if (folderWriter(root)) return;
  const dir = shadowDir(agentHome, root);
  await withLock(dir, async () => {
    initialized.delete(dir);
    await rm(dir, { recursive: true, force: true });
  }).catch((error: unknown) => {
    console.error('removing checkpoints failed:', error instanceof Error ? error.message : error);
  });
}

/** After deleting a file the run added, drop folders it left empty (never the root). */
async function removeEmptyParents(folder: string, root: string): Promise<void> {
  const stop = path.resolve(root);
  let current = path.resolve(folder);
  while (current.startsWith(stop) && current !== stop) {
    try {
      if ((await readdir(current)).length > 0) return;
      await rmdir(current);
    } catch {
      return;
    }
    current = path.dirname(current);
  }
}
