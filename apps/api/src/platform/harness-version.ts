import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';

import type { HarnessVersion } from '@agent/agent-models';

/**
 * The code this API process runs: HEAD plus a hash of `git diff HEAD`, read
 * once at start (the same hash the eval runner records,
 * `agent-eval/src/runner/runner.ts` `harnessVersion`). Edits after the API
 * started are not in the running code, so they are not in this value: a
 * mismatch tells an eval the API is stale. Null outside a git checkout.
 */
let cached: Promise<HarnessVersion | null> | null = null;

function repoRoot(): string {
  let dir = process.cwd();
  for (;;) {
    if (existsSync(path.join(dir, 'nx.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return process.cwd();
    dir = parent;
  }
}

function git(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, windowsHide: true, maxBuffer: 256 * 1024 * 1024 }, (error, stdout) =>
      resolve(error ? null : stdout),
    );
  });
}

export function harnessVersion(): Promise<HarnessVersion | null> {
  cached ??= (async () => {
    const root = repoRoot();
    const head = await git(root, ['rev-parse', 'HEAD']);
    if (!head) return null;
    // Same pathspec as the eval runner: the task corpus (evals/) is not harness code.
    const diff = (await git(root, ['diff', 'HEAD', '--', '.', ':(exclude)evals'])) ?? '';
    return {
      sha: head.trim(),
      dirty: diff.trim() ? createHash('sha256').update(diff).digest('hex').slice(0, 16) : null,
    };
  })();
  return cached;
}
