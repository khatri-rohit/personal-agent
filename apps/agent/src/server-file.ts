import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { createAgentClient } from '@agent/agent-client';
import {
  parseServerInfo,
  parseVersionInfo,
  SERVER_FILE,
  serverOrigin,
  type HarnessVersion,
  type ServerInfo,
} from '@agent/agent-models';

/** A server that answered for its home, with the code it runs. */
export type LiveServer = ServerInfo & { harnessVersion: HarnessVersion | null };

/**
 * One server per agent home (F3): `AGENT_HOME/server.json`. A second start
 * attaches to the live server instead of writing the same files. The file is
 * trusted only after the server answers for the same home, because a crash
 * leaves it behind and Windows reuses process ids.
 */

function readInfo(home: string): ServerInfo | null {
  try {
    return parseServerInfo(JSON.parse(readFileSync(path.join(home, SERVER_FILE), 'utf8')));
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function token(home: string): string | undefined {
  try {
    return readFileSync(path.join(home, 'api-token'), 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}

/** The home's running server, when its file names a live process that answers for this home. */
export async function liveServer(home: string): Promise<LiveServer | null> {
  const info = readInfo(home);
  if (!info || info.pid === process.pid || !pidAlive(info.pid)) return null;
  const key = token(home);
  const client = createAgentClient({ baseUrl: serverOrigin(info), ...(key ? { token: key } : {}) });
  try {
    const res = await client.request('version', { init: { signal: AbortSignal.timeout(1_500) } });
    if (!res.ok) return null;
    const version = parseVersionInfo(await res.json());
    if (!version || path.resolve(version.agentHome) !== path.resolve(home)) return null;
    return { ...info, harnessVersion: version.harnessVersion };
  } catch {
    return null;
  }
}

/** Record this process as the home's server (replacing a stale file), atomically: a reader never sees half a record. */
export function writeServerFile(home: string, info: ServerInfo): void {
  const target = path.join(home, SERVER_FILE);
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(info, null, 2)}\n`, 'utf8');
  renameSync(tmp, target);
}

/** Remove the file if it is still this process's. */
export function removeServerFile(home: string): void {
  if (readInfo(home)?.pid !== process.pid) return;
  try {
    unlinkSync(path.join(home, SERVER_FILE));
  } catch {
    // Already gone.
  }
}
