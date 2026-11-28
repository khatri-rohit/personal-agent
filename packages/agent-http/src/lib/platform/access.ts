import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { NextFunction, Request, Response } from 'express';

/**
 * Who may drive the API. The API listens on loopback, so
 * the threat is the browser: any page the user has open can send requests to
 * localhost.
 *
 * - The chat UI is served from this server's own origin. A browser marks
 *   every request it sends with `Sec-Fetch-Site`, which page scripts cannot
 *   forge: only `same-origin` is our page. When the browser also sends an
 *   `Origin`, it must equal this server's exact origin (scheme, host, port).
 *   Another localhost port is `same-site`, a foreign page `cross-site`: both
 *   are refused, and no CORS headers are ever sent.
 * - A request with neither header is not from a browser page (CLI tools, the
 *   eval runner, curl): it must carry the token from AGENT_HOME/api-token.
 *   A page cannot read that file; a local process that can is already past
 *   any boundary this API could draw.
 * - The `Host` header must name loopback, so a hostile domain that resolves
 *   to 127.0.0.1 (DNS rebinding) is refused before it reaches a route.
 */

export const API_TOKEN_FILE = 'api-token';
export const API_TOKEN_HEADER = 'x-agent-token';

/** How a request was let in; routes read it from `res.locals.client`. */
export type ApiClientKind = 'browser' | 'token';

/** The token in AGENT_HOME/api-token, created on first start (readable by this user only, where the OS supports it). */
export function loadOrCreateApiToken(agentHome: string): string {
  const file = path.join(agentHome, API_TOKEN_FILE);
  if (existsSync(file)) {
    const existing = readFileSync(file, 'utf8').trim();
    if (existing.length >= 32) return existing;
  }
  mkdirSync(agentHome, { recursive: true });
  const token = randomBytes(32).toString('hex');
  writeFileSync(file, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
  return token;
}

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** `localhost:3333` → `localhost`; `[::1]:3333` → `[::1]`. */
function hostnameOf(hostHeader: string): string {
  const value = hostHeader.trim().toLowerCase();
  if (value.startsWith('[')) return value.slice(0, value.indexOf(']') + 1);
  return value.split(':')[0] ?? '';
}

function listEnv(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

export type AccessPolicy = {
  token: string;
  /** Extra host names (AGENT_ALLOWED_HOSTS), for an API reached by another name. */
  hosts: string[];
  /**
   * Whether a same-origin browser page is admitted without the token. Off when
   * the server is bound to a non-loopback address: then every request needs it.
   */
  browser: boolean;
};

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTNAMES.has(host.trim().toLowerCase());
}

export function accessPolicyFromEnv(
  token: string,
  env: NodeJS.ProcessEnv = process.env,
  options: { browser?: boolean } = {},
): AccessPolicy {
  return { token, hosts: listEnv(env.AGENT_ALLOWED_HOSTS), browser: options.browser ?? true };
}

/** This server's origin as the browser sees it: the (allow-listed) Host it was reached by. */
function ownOrigin(req: Request): string {
  return `${req.protocol}://${String(req.headers.host ?? '').trim().toLowerCase()}`;
}

/** A browser request is ours only when the browser says so (Fetch Metadata) and any Origin is exactly ours. */
export function isSameOriginBrowser(req: Request): boolean {
  if (req.headers['sec-fetch-site'] !== 'same-origin') return false;
  const origin = req.headers.origin;
  return origin === undefined || origin.trim().toLowerCase() === ownOrigin(req);
}

function isBrowserRequest(req: Request): boolean {
  return req.headers['sec-fetch-site'] !== undefined || req.headers.origin !== undefined;
}

function tokenOf(req: Request): string | undefined {
  const header = req.headers[API_TOKEN_HEADER];
  if (typeof header === 'string' && header.trim()) return header.trim();
  const auth = req.headers.authorization;
  const bearer = typeof auth === 'string' ? /^Bearer\s+(.+)$/i.exec(auth.trim())?.[1] : undefined;
  return bearer?.trim() || undefined;
}

function sameToken(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Express middleware: the Host check, for every path (the UI shell included). */
export function hostGuard(policy: AccessPolicy) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const host = typeof req.headers.host === 'string' ? hostnameOf(req.headers.host) : '';
    if (!LOOPBACK_HOSTNAMES.has(host) && !policy.hosts.includes(host)) {
      res.status(403).json({ error: `Host "${host}" is not this API. Set AGENT_ALLOWED_HOSTS to reach it by another name.` });
      return;
    }
    next();
  };
}

/** Express middleware for `/api`, mounted after `hostGuard` and before every router. */
export function accessGuard(policy: AccessPolicy) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (isBrowserRequest(req)) {
      if (!policy.browser || !isSameOriginBrowser(req)) {
        const from = req.headers.origin ?? `a ${String(req.headers['sec-fetch-site'] ?? 'browser')} page`;
        res.status(403).json({ error: `${from} may not use this API: only this server's own page may.` });
        return;
      }
      res.locals.client = 'browser' satisfies ApiClientKind;
      next();
      return;
    }
    const given = tokenOf(req);
    if (!given || !sameToken(given, policy.token)) {
      res.status(401).json({
        error: `This API needs its token: send the contents of AGENT_HOME/${API_TOKEN_FILE} as "Authorization: Bearer <token>" or "${API_TOKEN_HEADER}".`,
      });
      return;
    }
    res.locals.client = 'token' satisfies ApiClientKind;
    next();
  };
}
