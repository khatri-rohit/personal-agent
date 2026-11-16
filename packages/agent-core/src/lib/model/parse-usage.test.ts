import { describe, expect, it } from 'vitest';

import { parseTokenUsage, rawUsage } from './parse-usage';

describe('parseTokenUsage', () => {
  it('maps prompt, completion and total tokens', () => {
    expect(parseTokenUsage({ prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 })).toEqual({
      promptTokens: 10,
      completionTokens: 3,
      totalTokens: 13,
    });
  });

  it('returns undefined without a finite prompt_tokens', () => {
    expect(parseTokenUsage({ completion_tokens: 3 })).toBeUndefined();
    expect(parseTokenUsage(null)).toBeUndefined();
  });

  it('leaves cachedTokens out when the provider reports no cache counter', () => {
    expect(parseTokenUsage({ prompt_tokens: 10, completion_tokens: 3 })).not.toHaveProperty('cachedTokens');
  });

  it.each([
    ['OpenAI-compatible', { prompt_tokens_details: { cached_tokens: 8 } }],
    ['DeepSeek', { prompt_cache_hit_tokens: 8 }],
    ['Anthropic-style', { cache_read_input_tokens: 8 }],
    ['top level', { cached_tokens: 8 }],
  ])('reads cached prompt tokens (%s)', (_label, cache) => {
    expect(parseTokenUsage({ prompt_tokens: 10, completion_tokens: 3, ...cache })?.cachedTokens).toBe(8);
  });

  it('keeps a reported 0 (reported, nothing cached)', () => {
    expect(parseTokenUsage({ prompt_tokens: 10, prompt_tokens_details: { cached_tokens: 0 } })?.cachedTokens).toBe(0);
  });
});

describe('rawUsage', () => {
  it('passes an object through and rejects anything else', () => {
    expect(rawUsage({ prompt_tokens: 1 })).toEqual({ prompt_tokens: 1 });
    expect(rawUsage(undefined)).toBeUndefined();
    expect(rawUsage([1])).toBeUndefined();
  });
});
