import { describe, expect, it } from 'vitest';

import { chunkSpeech, toSpeechText } from './speech-text';

describe('toSpeechText', () => {
  it('reads prose, drops markup, and marks code and tables', () => {
    const md = [
      '## Summary',
      'The fix is in **two** places: `voice.routes.ts` and the [hook](https://x.y/z).',
      '',
      '- First item',
      '- Second _item_',
      '',
      '```ts',
      'const x = 1;',
      '```',
      '',
      '| a | b |',
      '|---|---|',
      '| 1 | 2 |',
      '',
      '> See https://example.com for more.',
    ].join('\n');

    expect(toSpeechText(md)).toBe(
      'Summary. The fix is in two places: voice.routes.ts and the hook. ' +
        'First item. Second item. Code block skipped. Table skipped. ' +
        'See link for more.',
    );
  });

  it('marks an unterminated code block (streaming reply)', () => {
    expect(toSpeechText('Here:\n```ts\nconst x')).toBe('Here: Code block skipped.');
  });

  it('collapses repeated markers', () => {
    expect(toSpeechText('```\na\n```\n\n```\nb\n```')).toBe('Code block skipped.');
  });

  it('keeps snake_case identifiers intact', () => {
    expect(toSpeechText('Call my_var_name now')).toBe('Call my_var_name now.');
  });
});

describe('chunkSpeech', () => {
  it('keeps dotted names and decimals inside one sentence', () => {
    expect(chunkSpeech('Open voice.routes.ts at 3.5 seconds. Done.')).toEqual([
      'Open voice.routes.ts at 3.5 seconds. Done.',
    ]);
  });

  it('makes the first chunk short so audio starts fast', () => {
    const sentence = 'This sentence is about sixty characters long, give or take. ';
    const chunks = chunkSpeech(sentence.repeat(10).trim());
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks[0]!.length).toBeLessThanOrEqual(140);
    for (const c of chunks.slice(1)) expect(c.length).toBeLessThanOrEqual(280);
  });

  it('hard-splits a sentence with no punctuation at a word', () => {
    const chunks = chunkSpeech('word '.repeat(400).trim());
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(600);
      expect(c.startsWith(' ') || c.endsWith(' ')).toBe(false);
    }
    expect(chunks.join(' ')).toBe('word '.repeat(400).trim());
  });

  it('returns nothing for empty text', () => {
    expect(chunkSpeech('')).toEqual([]);
  });
});
