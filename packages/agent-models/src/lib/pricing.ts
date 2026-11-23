/**
 * Per-model list prices, in USD per 1M tokens, for pricing what a task cost
 * (eval gate, reports). Not a runtime budget: run caps stay in raw tokens.
 *
 * Source: https://ollama.com/pricing, read 2026-11-21 (peak rates; the
 * off-peak discount is not applied). Prices change: a model missing here
 * prices as unknown, never as free.
 */
export const MODEL_PRICES_SOURCE = { url: 'https://ollama.com/pricing', readOn: '2026-11-21' } as const;

export type ModelPrice = {
  /** Uncached prompt tokens. */
  input: number;
  /** Prompt tokens served from the provider's cache. */
  cachedInput: number;
  /** Completion tokens (thinking included, as the provider bills it). */
  output: number;
};

export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  'deepseek-v4.1-flash': { input: 0.3, cachedInput: 0.006, output: 1.2 },
  'glm-5.2': { input: 1.4, cachedInput: 0.26, output: 4.4 },
  'glm-5.3': { input: 1.4, cachedInput: 0.26, output: 4.4 },
  'glm-5.3-flash': { input: 0.15, cachedInput: 0.03, output: 0.5 },
  'kimi-k2.6': { input: 0.95, cachedInput: 0.16, output: 4.0 },
  'kimi-k2.7-code': { input: 0.95, cachedInput: 0.19, output: 4.0 },
  'kimi-k3': { input: 3.0, cachedInput: 0.3, output: 15.0 },
  'kimi-k3.1-pro': { input: 2.0, cachedInput: 0.2, output: 10.0 },
};

/** `glm-5.3:cloud` and `glm-5.3` are one model: the tag after `:` is dropped. */
export function modelPrice(model: string | undefined): ModelPrice | null {
  if (!model) return null;
  const base = model.trim().toLowerCase().split(':')[0] ?? '';
  return Object.hasOwn(MODEL_PRICES, base) ? MODEL_PRICES[base]! : null;
}

/**
 * USD for one model call, or null when it cannot be priced: an unknown
 * model, or a call whose provider did not report cached tokens (cached and
 * uncached differ up to 50× in price, so guessing would make costs noise).
 */
export function callCostUsd(
  model: string | undefined,
  usage: { promptTokens: number; completionTokens: number; cachedTokens?: number },
): number | null {
  const price = modelPrice(model);
  if (!price || usage.cachedTokens === undefined) return null;
  const cached = Math.min(Math.max(0, usage.cachedTokens), usage.promptTokens);
  const uncached = Math.max(0, usage.promptTokens - cached);
  return (uncached * price.input + cached * price.cachedInput + Math.max(0, usage.completionTokens) * price.output) / 1e6;
}
