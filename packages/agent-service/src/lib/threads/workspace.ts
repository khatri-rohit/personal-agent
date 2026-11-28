import { stat } from 'node:fs/promises';
import path from 'node:path';

import type { AgentService } from '../service';
import { isAllowedWorkspace } from './workspace-allowlist';

/** An existing directory, absolute and normalized; or why not. */
export async function resolveWorkspaceDir(
  raw: string,
): Promise<{ ok: true; root: string } | { ok: false; error: string }> {
  const root = path.resolve(raw.trim());
  try {
    const info = await stat(root);
    if (!info.isDirectory()) {
      return { ok: false, error: 'workspaceRoot must be a directory' };
    }
  } catch {
    return { ok: false, error: `workspaceRoot does not exist: ${root}` };
  }
  return { ok: true, root: path.normalize(root) };
}

/**
 * Whether this caller may open `root` as a workspace. A browser may open only
 * a folder a person chose (B1, workspace-allowlist.ts); a trusted local
 * process (`trustedCaller`: it presented the API token) may open any
 * existing folder.
 */
export async function workspaceAllowed(
  service: Pick<AgentService, 'threads' | 'home' | 'config'>,
  root: string,
  trustedCaller: boolean,
): Promise<boolean> {
  if (trustedCaller) return true;
  const store = await service.threads();
  return isAllowedWorkspace({
    agentHome: service.home(),
    root,
    threadRoots: store.listThreads({ includeSubagents: true }).map((thread) => thread.workspaceRoot),
    workspaceRoots: service.config.workspaceRoots,
  });
}

/**
 * The runs a checkpoint request names, kept only when they are this
 * thread's runs, in ledger order (a run id becomes a git ref name, so
 * nothing else gets through).
 */
export async function threadRunIds(
  service: Pick<AgentService, 'threads'>,
  threadId: string,
  raw: unknown,
): Promise<string[]> {
  const wanted = new Set(
    (Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : []).filter(
      (id): id is string => typeof id === 'string' && id.length > 0,
    ),
  );
  if (wanted.size === 0) return [];
  const store = await service.threads();
  const ordered: string[] = [];
  for (const envelope of await store.readLedger(threadId, 0)) {
    if (envelope.runId && wanted.has(envelope.runId) && !ordered.includes(envelope.runId)) ordered.push(envelope.runId);
  }
  return ordered;
}
