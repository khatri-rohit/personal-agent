/**
 * The environment a workspace command runs with: the host's, minus what the
 * model must never see or inherit. Commands print into the transcript, and
 * the transcript goes to the model provider, so a key in the environment is
 * one `set` away from leaving the machine.
 *
 * A deny rule, not an allowlist: toolchains need many variables (nx, Python
 * venvs, JAVA_HOME, nvm, Windows system paths), and a fixed list breaks them.
 */

/** A name part that says secret (`OLLAMA_API_KEY`, `GH_TOKEN`, `DB_PASSWORD`); `PWD` and `PATHEXT` are not. */
const SECRET_PART = /(^|_)(API_?KEY|KEY|KEYS|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|AUTH)(_|$)/i;

/** The host's own settings (its .env): models, voice, System 1, agent home, its address. */
const HOST_PREFIXES = ['OLLAMA_', 'SYSTEMONE_', 'SPEACHES_', 'VOICE_', 'AGENT_'];
const HOST_NAMES = new Set(['CORS_ORIGIN', 'HOST', 'PORT']);

/**
 * Nx's variables from the host's own `nx serve`: an inherited workspace root
 * can point nx, run by the agent in another workspace, back at this repo.
 */
const NX_PREFIX = 'NX_';

/** A URL carrying a user or password (`redis://user:pass@host`). */
const URL_WITH_CREDENTIALS = /^[a-z][a-z0-9+.-]*:\/\/[^/@\s]+@/i;

/** Why a variable is left out, or null when it is passed on. */
export function droppedEnvReason(name: string, value: string | undefined): string | null {
  const upper = name.toUpperCase();
  if (SECRET_PART.test(upper)) return 'secret name';
  if (HOST_NAMES.has(upper) || HOST_PREFIXES.some((prefix) => upper.startsWith(prefix))) return 'host setting';
  if (upper.startsWith(NX_PREFIX)) return 'host nx task';
  if (value && URL_WITH_CREDENTIALS.test(value.trim())) return 'URL with credentials';
  return null;
}

/** The host environment without secrets, host settings and host nx variables. */
export function commandEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined || droppedEnvReason(name, value) !== null) continue;
    env[name] = value;
  }
  return env;
}
