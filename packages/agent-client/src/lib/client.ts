import { API_MOUNTS, API_ROUTES, type ApiMount, type ApiRouteName } from '@agent/agent-models';

export type AgentClientOptions = {
  /** Origin of the agent host, e.g. `http://localhost:3333`; `''` for same-origin. */
  baseUrl: string;
  /**
   * The API token (AGENT_HOME/api-token) for a local process such as the eval
   * runner or a script. A browser page sends none: it is admitted by origin.
   */
  token?: string;
  /** Defaults to the global `fetch`, looked up on each call. */
  fetch?: typeof fetch;
  /**
   * Mount paths to use instead of the protocol's, for a `baseUrl` that already
   * ends in one (the eval CLI's `--api http://host:port/api/agent` passes
   * `{ agent: '' }`).
   */
  mounts?: Partial<Record<ApiMount, string>>;
};

export type RequestOptions = {
  /** Values for the route's `:name` path segments. */
  params?: Readonly<Record<string, string>>;
  /** The query string as built by the caller, without the leading `?`. */
  query?: string;
  /** Everything else of the request (body, headers, signal). The method comes from the route. */
  init?: Omit<RequestInit, 'method'>;
};

/**
 * The only HTTP client of the agent host. It knows every
 * route's method and URL from the protocol table and adds the token when it
 * has one; reading the response stays with the caller, so each caller keeps
 * its own handling of statuses and bodies.
 */
export type AgentClient = {
  /** The full URL of a route (for EventSource and links). */
  url(name: ApiRouteName, params?: RequestOptions['params'], query?: string): string;
  request(name: ApiRouteName, options?: RequestOptions): Promise<Response>;
  /** Headers for a request made outside `request` (only the token, when there is one). */
  authHeaders(): Record<string, string>;
};

function fillPath(path: string, params: RequestOptions['params']): string {
  return path.replace(/:([A-Za-z]+)/g, (_match, name: string) => {
    const value = params?.[name];
    if (value === undefined) throw new Error(`agent-client: missing path parameter "${name}" for ${path}`);
    return encodeURIComponent(value);
  });
}

export function createAgentClient(options: AgentClientOptions): AgentClient {
  const base = options.baseUrl.replace(/\/+$/, '');
  const doFetch: typeof fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const authHeaders = (): Record<string, string> =>
    options.token ? { Authorization: `Bearer ${options.token}` } : {};

  const url: AgentClient['url'] = (name, params, query) => {
    const route = API_ROUTES[name];
    const mount = options.mounts?.[route.mount] ?? API_MOUNTS[route.mount];
    return `${base}${mount}${fillPath(route.path, params)}${query ? `?${query}` : ''}`;
  };

  return {
    url,
    authHeaders,
    request(name, request = {}) {
      const route = API_ROUTES[name];
      const init: RequestInit = { ...request.init, method: route.method };
      if (options.token) {
        const headers = new Headers(request.init?.headers);
        headers.set('Authorization', `Bearer ${options.token}`);
        init.headers = headers;
      }
      return doFetch(url(name, request.params, request.query), init);
    },
  };
}
