/**
 * Ollama native APIs: POST /api/show (capabilities) and GET /api/tags (installed models).
 * Chat still uses the OpenAI-compatible /v1 client.
 */

import {
  classifyThinking,
  resolveReasoningEffort,
  type OllamaEndpoint,
  type OllamaListedModel,
  type OllamaModelConfig,
  type SideCallThinking,
  type ThinkingValue,
} from '@agent/agent-models';

import { nativeOllamaBaseUrl } from './client';

type ShowResponse = {
  error?: string;
  capabilities?: string[];
  thinking?: { values?: ThinkingValue[]; default?: ThinkingValue };
  model_info?: Record<string, unknown>;
};

type TagsResponse = {
  models?: Array<{
    name?: string;
    model?: string;
    size?: number;
    modified_at?: string;
    details?: { family?: string };
  }>;
  error?: string;
};

const configCache = new Map<string, OllamaModelConfig>();

function authHeaders(): Record<string, string> {
  if (!process.env.OLLAMA_API_KEY) return {};
  return { Authorization: `Bearer ${process.env.OLLAMA_API_KEY}` };
}

function contextLength(
  modelInfo: Record<string, unknown> | undefined,
): number | null {
  if (!modelInfo) return null;
  for (const [key, value] of Object.entries(modelInfo)) {
    if (key.endsWith('.context_length') && typeof value === 'number') {
      return value;
    }
  }
  return null;
}

// Pure thinking helpers live in agent-models so the eval app shares them.
export { resolveReasoningEffort } from '@agent/agent-models';

function cacheKey(endpoint: OllamaEndpoint, model: string): string {
  return `${endpoint}:${model}`;
}

/**
 * Side-call thinking preference (off/low/medium/high) mapped onto the
 * model's own thinking values via resolveReasoningEffort, which already
 * owns the fallback policy (nearest supported level, else model default).
 */
export function sideCallReasoningEffort(
  cfg: OllamaModelConfig,
  thinking: SideCallThinking,
): string | undefined {
  if (thinking === 'off') {
    return cfg.thinking.values.includes(false)
      ? resolveReasoningEffort(cfg, false)
      : undefined;
  }
  return resolveReasoningEffort(cfg, thinking);
}

/** Cached config only — never touches the network. */
export function peekOllamaModelConfig(
  model: string,
  endpoint: OllamaEndpoint = 'cloud',
): OllamaModelConfig | undefined {
  return configCache.get(cacheKey(endpoint, model));
}

export async function getOllamaModelConfig(
  model: string,
  endpoint: OllamaEndpoint = 'cloud',
): Promise<OllamaModelConfig> {
  const key = cacheKey(endpoint, model);
  const hit = configCache.get(key);
  if (hit) return hit;

  const res = await fetch(`${nativeOllamaBaseUrl(endpoint)}/api/show`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
    },
    body: JSON.stringify({ model }),
    signal: AbortSignal.timeout(15_000),
  });

  const data = (await res.json().catch(() => ({}))) as ShowResponse;
  if (!res.ok) {
    throw new Error(
      `show failed: ${res.status} ${data.error ?? JSON.stringify(data)}`,
    );
  }
  if (data.error) throw new Error(data.error);

  const capabilities = data.capabilities ?? [];
  const config: OllamaModelConfig = {
    model,
    capabilities,
    contextLength: contextLength(data.model_info),
    thinking: classifyThinking(data.thinking),
    supportsTools: capabilities.includes('tools'),
    supportsVision: capabilities.includes('vision'),
  };
  configCache.set(key, config);
  return config;
}

function withTag(name: string): string {
  return name.includes(':') ? name : `${name}:latest`;
}

type PsResponse = {
  models?: Array<{ name?: string; model?: string; context_length?: number }>;
};

/**
 * Context length the daemon has this model loaded with (GET /api/ps), or
 * null when the model is not loaded or the daemon does not report it.
 * Never cached: a reload can change it. Never throws.
 */
export async function getServedContextLength(
  model: string,
  endpoint: OllamaEndpoint = 'local',
): Promise<number | null> {
  try {
    const res = await fetch(`${nativeOllamaBaseUrl(endpoint)}/api/ps`, {
      headers: { ...authHeaders() },
      signal: AbortSignal.timeout(3_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as PsResponse;
    // The daemon lists an untagged pick as `name:latest`.
    const wanted = withTag(model);
    const loaded = data.models?.find(
      (row) => withTag(row.name ?? '') === wanted || withTag(row.model ?? '') === wanted,
    );
    const served = loaded?.context_length;
    return typeof served === 'number' && served > 0 ? served : null;
  } catch {
    return null;
  }
}

/** List models installed on the Ollama daemon (GET /api/tags). */
export async function listOllamaModels(
  endpoint: OllamaEndpoint = 'local',
): Promise<OllamaListedModel[]> {
  const res = await fetch(`${nativeOllamaBaseUrl(endpoint)}/api/tags`, {
    headers: { ...authHeaders() },
    signal: AbortSignal.timeout(10_000),
  });

  const data = (await res.json().catch(() => ({}))) as TagsResponse;
  if (!res.ok) {
    throw new Error(
      `tags failed: ${res.status} ${data.error ?? JSON.stringify(data)}`,
    );
  }
  if (data.error) throw new Error(data.error);

  const models: OllamaListedModel[] = [];
  for (const row of data.models ?? []) {
    const id = (row.name ?? row.model ?? '').trim();
    if (!id) continue;
    models.push({
      id,
      size: typeof row.size === 'number' ? row.size : null,
      modifiedAt: typeof row.modified_at === 'string' ? row.modified_at : null,
      family:
        typeof row.details?.family === 'string' ? row.details.family : null,
    });
  }
  return models;
}
