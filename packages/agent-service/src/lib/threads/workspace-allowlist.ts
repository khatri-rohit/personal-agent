import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { sameWorkspaceRoot } from '@agent/agent-models';

/**
 * Folders a browser request may open as a workspace (B1). A page must not
 * be able to point the agent at any folder on disk, so a folder is allowed
 * only when a person chose it:
 * - picked in the folder dialog (`/workspace/pick` records it here);
 * - already used by a thread (it was chosen before this rule existed);
 * - under AGENT_WORKSPACE_ROOTS (path list), for folders set up by hand.
 * Token clients (eval runner, CLI tools) are not checked: they already
 * have the local access this rule protects.
 */

export const WORKSPACES_FILE = 'workspaces.json';

type StoredWorkspaces = { roots: string[] };

function filePath(agentHome: string): string {
  return path.join(agentHome, WORKSPACES_FILE);
}

async function readRoots(agentHome: string): Promise<string[]> {
  try {
    const parsed = JSON.parse(await readFile(filePath(agentHome), 'utf8')) as Partial<StoredWorkspaces>;
    return Array.isArray(parsed.roots) ? parsed.roots.filter((root): root is string => typeof root === 'string') : [];
  } catch {
    return [];
  }
}

/** Record a folder the person picked in the dialog. */
export async function rememberWorkspace(agentHome: string, root: string): Promise<void> {
  const roots = await readRoots(agentHome);
  if (roots.some((known) => sameWorkspaceRoot(known, root))) return;
  roots.push(root);
  await writeFile(filePath(agentHome), `${JSON.stringify({ roots } satisfies StoredWorkspaces, null, 2)}\n`, 'utf8');
}

/** `root` equals `parent` or sits inside it (case-insensitive on Windows). */
function isWithin(root: string, parent: string): boolean {
  const norm = (value: string) => {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  const relative = path.relative(norm(parent), norm(root));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export async function isAllowedWorkspace(input: {
  agentHome: string;
  root: string;
  /** Workspace roots of existing threads. */
  threadRoots: Array<string | undefined>;
  env?: NodeJS.ProcessEnv;
}): Promise<boolean> {
  const { root } = input;
  if (input.threadRoots.some((known) => known !== undefined && sameWorkspaceRoot(known, root))) return true;
  const configured = (input.env ?? process.env).AGENT_WORKSPACE_ROOTS ?? '';
  for (const parent of configured.split(path.delimiter).map((item) => item.trim()).filter(Boolean)) {
    if (isWithin(root, parent)) return true;
  }
  return (await readRoots(input.agentHome)).some((known) => sameWorkspaceRoot(known, root));
}

export const WORKSPACE_NOT_PICKED =
  'This folder was not chosen in the folder picker. Pick it with "Open folder" first (or add it to AGENT_WORKSPACE_ROOTS).';
