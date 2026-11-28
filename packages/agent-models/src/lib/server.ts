/**
 * The running server of an agent home: `AGENT_HOME/server.json`, written
 * once the server listens and removed when it stops. Readers (a second
 * `agent web`, the eval runner) attach to it instead of guessing a port. The
 * file alone proves nothing after a crash: a reader checks it answers.
 */

export const SERVER_FILE = 'server.json';

export type ServerInfo = {
  pid: number;
  /** As the server was bound (`localhost`, `127.0.0.1`, …). */
  host: string;
  port: number;
  /** The home this server owns, resolved. */
  agentHome: string;
  startedAt: string;
};

/** `http://localhost:3333` for a server (brackets for an IPv6 host). */
export function serverOrigin(info: Pick<ServerInfo, 'host' | 'port'>): string {
  const host = info.host.includes(':') && !info.host.startsWith('[') ? `[${info.host}]` : info.host;
  return `http://${host}:${info.port}`;
}

/** The file's contents, or null when it is not a server record. */
export function parseServerInfo(raw: unknown): ServerInfo | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const value = raw as Record<string, unknown>;
  const { pid, host, port, agentHome, startedAt } = value;
  if (
    typeof pid !== 'number' ||
    typeof host !== 'string' ||
    typeof port !== 'number' ||
    !Number.isInteger(port) ||
    port <= 0 ||
    typeof agentHome !== 'string' ||
    typeof startedAt !== 'string'
  ) {
    return null;
  }
  return { pid, host, port, agentHome, startedAt };
}
