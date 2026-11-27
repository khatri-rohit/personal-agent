/**
 * Embeds the built chat UI (apps/web/dist) into this app's bundle folder as
 * dist/ui, which `agent serve` serves. A plain copy: Nx's asset copier skips
 * git-ignored folders such as apps/web/dist.
 */
import { cpSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const from = path.resolve(appRoot, '../web/dist');
const to = path.join(appRoot, 'dist/ui');

if (!existsSync(path.join(from, 'index.html'))) {
  console.error(`embed-ui: no built UI at ${from} (run nx build @agent/web)`);
  process.exit(1);
}
rmSync(to, { recursive: true, force: true });
cpSync(from, to, { recursive: true });
console.log(`embed-ui: ${from} -> ${to}`);
