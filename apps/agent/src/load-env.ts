import { existsSync } from 'node:fs';
import path from 'node:path';

import dotenv from 'dotenv';

/**
 * Imported first by main.ts, before anything imports the engine: the engine
 * and the voice proxy read `OLLAMA_*`, `VOICE_*` and the rest from
 * `process.env` when they load. Nx used to load the root `.env` for
 * `nx serve`; the app now does it itself, with the same files and rule
 * (`.env.local` before `.env`, never over a variable already set).
 */

/** The repo this build runs from (apps/agent/dist → the workspace root), else the cwd. */
export const REPO_ROOT = findRepoRoot();

function findRepoRoot(): string {
  for (const start of [__dirname, process.cwd()]) {
    let dir = start;
    for (;;) {
      if (existsSync(path.join(dir, 'nx.json'))) return dir;
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }
  return process.cwd();
}

const files = ['.env.local', '.env'].map((name) => path.join(REPO_ROOT, name)).filter((file) => existsSync(file));
if (files.length > 0) dotenv.config({ path: files });
