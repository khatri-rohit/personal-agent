import type { TokenUsage } from '@agent/agent-models';

type UsageLike = {
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  total_tokens?: number | null;
  /** OpenAI-compatible: cached prompt tokens. */
  prompt_tokens_details?: { cached_tokens?: number | null } | null;
  /** DeepSeek: prompt tokens served from its context cache. */
  prompt_cache_hit_tokens?: number | null;
  /** Anthropic-style: tokens read from the prompt cache. */
  cache_read_input_tokens?: number | null;
  /** Some providers report the count at the top level. */
  cached_tokens?: number | null;
};

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Cached prompt tokens from the shapes providers use, first found wins.
 * Undefined when none is reported (not reported is not the same as 0).
 */
function cachedTokensOf(u: UsageLike): number | undefined {
  return (
    finite(u.prompt_tokens_details?.cached_tokens) ??
    finite(u.prompt_cache_hit_tokens) ??
    finite(u.cache_read_input_tokens) ??
    finite(u.cached_tokens)
  );
}

/**
 * Map OpenAI-compat / Ollama `usage` objects into domain TokenUsage.
 * Returns undefined when prompt_tokens is missing or not a finite number.
 */
export function parseTokenUsage(usage: unknown): TokenUsage | undefined {
  if (!usage || typeof usage !== 'object') return undefined;
  const u = usage as UsageLike;
  const promptTokens = finite(u.prompt_tokens);
  if (promptTokens === undefined) return undefined;
  const completionTokens = finite(u.completion_tokens) ?? 0;
  const totalTokens = finite(u.total_tokens);
  const cachedTokens = cachedTokensOf(u);
  return {
    promptTokens,
    completionTokens,
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(cachedTokens !== undefined ? { cachedTokens } : {}),
  };
}

/** The provider's raw usage object, kept for diagnosis; undefined when it sent none. */
export function rawUsage(usage: unknown): Record<string, unknown> | undefined {
  return usage && typeof usage === 'object' && !Array.isArray(usage)
    ? (usage as Record<string, unknown>)
    : undefined;
}
