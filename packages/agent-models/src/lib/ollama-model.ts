/**
 * Ollama model capability snapshot (from native POST /api/show).
 * Shared contract between @agent/agent-core discovery, API JSON, and the web UI.
 * Zero runtime deps — shapes only.
 */

/** Chat + native API target: cloud (OLLAMA_BASE_URL) or local daemon. */
export type OllamaEndpoint = 'cloud' | 'local';

/** One row from Ollama GET /api/tags (installed models). */
export type OllamaListedModel = {
  id: string;
  size: number | null;
  modifiedAt: string | null;
  family: string | null;
};

export type ThinkingValue = boolean | string;

export type ThinkingMode = 'none' | 'boolean' | 'levels' | 'mixed';

export type OllamaThinkingConfig = {
  supported: boolean;
  values: ThinkingValue[];
  default: ThinkingValue | null;
  mode: ThinkingMode;
};

export type OllamaModelConfig = {
  model: string;
  capabilities: string[];
  contextLength: number | null;
  thinking: OllamaThinkingConfig;
  supportsTools: boolean;
  supportsVision: boolean;
  /**
   * Set by the API, not /api/show: System 1 can choose this model's thinking
   * level per step (offer "Auto" in the picker).
   */
  system1Auto?: boolean;
};

/** Thinking support from `/api/show`'s `thinking` block. Pure: shared by core and the eval app. */
export function classifyThinking(thinking?: { values?: ThinkingValue[]; default?: ThinkingValue }): OllamaThinkingConfig {
  const values = thinking?.values ?? [];
  const fallback = thinking?.default ?? null;

  if (values.length === 0 || (values.length === 1 && values[0] === false)) {
    return { supported: false, values, default: fallback, mode: 'none' };
  }

  const hasBool = values.some((v) => typeof v === 'boolean');
  const hasStr = values.some((v) => typeof v === 'string');
  const mode: ThinkingMode = hasBool && hasStr ? 'mixed' : hasStr ? 'levels' : 'boolean';

  return { supported: true, values, default: fallback, mode };
}

/** Map a UI/API thinking choice to the OpenAI-compatible `reasoning_effort`. */
export function resolveReasoningEffort(
  cfg: OllamaModelConfig,
  requested: ThinkingValue | undefined,
): string | undefined {
  if (!cfg.thinking.supported) return undefined;

  const req = requested ?? cfg.thinking.default;
  if (req === undefined || req === null) return undefined;

  const off = req === false || req === 'none';
  if (cfg.thinking.mode === 'boolean') {
    return off ? 'none' : 'medium';
  }
  if (off) {
    return cfg.thinking.values.includes(false) ? 'none' : undefined;
  }
  if (req === true) {
    const def = cfg.thinking.default;
    return typeof def === 'string' ? def : 'medium';
  }

  const asStr = String(req);
  if (cfg.thinking.values.includes(asStr)) return asStr;
  return typeof cfg.thinking.default === 'string' ? cfg.thinking.default : undefined;
}

/**
 * The middle thinking level a model offers (e.g. `medium` of low/medium/high):
 * neither the cheapest nor the slowest. `true` for on/off models, null when
 * the model has no thinking.
 */
export function middleThinking(cfg: OllamaThinkingConfig): ThinkingValue | null {
  if (!cfg.supported) return null;
  const levels = cfg.values.filter((value): value is string => typeof value === 'string' && value !== 'none');
  if (levels.length === 0) return true;
  return levels[Math.floor((levels.length - 1) / 2)] ?? levels[0]!;
}

/**
 * Ollama Cloud balance — from GET https://ollama.com/api/balance.
 * Two plan shapes: legacy (session + weekly remaining %) or modern (USD balance).
 */

export type OllamaBalanceLimit = {
  remainingPercent: number;
  resetsAt: string;
};

export type OllamaBalanceLegacy = {
  session: OllamaBalanceLimit;
  weekly: OllamaBalanceLimit;
};

export type OllamaBalanceModern = {
  balanceUsd: number;
  allowanceUsd: number;
  period: { from: string; until: string };
};

export type OllamaBalance = {
  legacy?: OllamaBalanceLegacy;
  modern?: OllamaBalanceModern;
  purchasedUsd?: number;
};
