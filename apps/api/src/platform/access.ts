import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { NextFunction, Request, Response } from 'express';

/**
 * Who may drive the API (B1). The API listens on loopback, so the threat is
 * the browser: any page the user has open can send requests to localhost.
 *
 * - The web app is always cross-origin to the API (another port), so its
 *   `fetch` and `EventSource` requests carry an `Origin`. A loopback origin
 *   (or one in CORS_ORIGIN) is the web app; any other origin is refused.
 * - A request with no `Origin` is not from a page's script (CLI tools, the
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
  /** Exact origins (CORS_ORIGIN). Empty = any loopback origin, any port. */
  origins: string[];
  /** Extra host names (AGENT_ALLOWED_HOSTS), for an API reached by another name. */
  hosts: string[];
};

export function accessPolicyFromEnv(token: string, env: NodeJS.ProcessEnv = process.env): AccessPolicy {
  return { token, origins: listEnv(env.CORS_ORIGIN), hosts: listEnv(env.AGENT_ALLOWED_HOSTS) };
}

/** The web app's origin: one of CORS_ORIGIN, or else any http(s) loopback origin. `null` (sandboxed frames, files) never. */
export function isAllowedOrigin(origin: string, policy: Pick<AccessPolicy, 'origins'>): boolean {
  const value = origin.trim().toLowerCase();
  if (policy.origins.length > 0) return policy.origins.includes(value);
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && LOOPBACK_HOSTNAMES.has(url.hostname);
  } catch {
    return false;
  }
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

/** Express middleware, mounted before CORS and every router. */
export function accessGuard(policy: AccessPolicy) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const host = typeof req.headers.host === 'string' ? hostnameOf(req.headers.host) : '';
    if (!LOOPBACK_HOSTNAMES.has(host) && !policy.hosts.includes(host)) {
      res.status(403).json({ error: `Host "${host}" is not this API. Set AGENT_ALLOWED_HOSTS to reach it by another name.` });
      return;
    }
    const origin = req.headers.origin;
    if (typeof origin === 'string') {
      if (!isAllowedOrigin(origin, policy)) {
        res.status(403).json({ error: `Origin ${origin} may not use this API. Set CORS_ORIGIN to allow it.` });
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
