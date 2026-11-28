import { describe, expect, it } from 'vitest';
import type { LedgerEnvelope, ToolContext } from '@agent/agent-models';

import { createReadThreadTool, readThreadPage, threadMessages, type ThreadReadSource } from './read-thread';

const ctx: ToolContext = {
  runId: 'r1',
  threadId: 'current',
  origin: 'eval',
  signal: new AbortController().signal,
};

function row(seq: number, record: LedgerEnvelope['record'], extra: Partial<LedgerEnvelope> = {}): LedgerEnvelope {
  return { v: 1, seq, ts: '2026-01-01T00:00:00.000Z', threadId: 'other', runId: null, record, ...extra };
}

function source(envelopes: LedgerEnvelope[], running = false): ThreadReadSource {
  return { title: 'Fix login', sourceLabel: 'Home', running, envelopes };
}

describe('threadMessages', () => {
  it('keeps user and assistant text whole, lists tool calls, drops tool results', () => {
    const messages = threadMessages([
      row(1, { role: 'user', content: 'Why does login fail?' }, {
        attachments: [{ id: 'i1', mimeType: 'image/png', dataUrl: 'data:image/png;base64,AA==' }],
      }),
      row(2, {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"src/auth.ts"}' } }],
      }),
      row(3, { role: 'tool', tool_call_id: 'c1', content: 'SECRET FILE BODY' }),
      row(4, { role: 'assistant', content: 'The token check is inverted.' }),
    ]);
    expect(messages).toEqual([
      'User\nWhy does login fail?\n[1 image]',
      'Assistant\nTool calls:\n- read_file: src/auth.ts',
      'Assistant\nThe token check is inverted.',
    ]);
  });
});

describe('readThreadPage', () => {
  const rows = Array.from({ length: 6 }, (_, i) =>
    row(i + 1, i % 2 === 0 ? { role: 'user', content: `question ${i}` } : { role: 'assistant', content: `answer ${i}` }),
  );

  it('pages whole messages and says where to go on', () => {
    const page = readThreadPage({ threadId: 'other', source: source(rows), pageChars: 60 });
    expect(page).toMatch(/^Thread "Fix login" \(Home\)\. Messages 1–\d of 6\./);
    expect(page).toContain('## [1] User\nquestion 0');
    expect(page).toMatch(/\(more: read_thread with thread_id "other", from=\d\)/);
  });

  it('reads to the end from a later message', () => {
    const page = readThreadPage({ threadId: 'other', source: source(rows), from: 5 });
    expect(page).toContain('Messages 5–6 of 6.');
    expect(page).toContain('(end of thread)');
  });

  it('splits one long message into parts instead of cutting it', () => {
    const long = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n');
    const source1 = source([row(1, { role: 'assistant', content: long })]);
    const first = readThreadPage({ threadId: 'other', source: source1, pageChars: 120 });
    expect(first).toMatch(/Message 1 of 1, part 1 of \d+/);
    expect(first).toContain('part=2');
    const parts: string[] = [];
    for (let part = 1; part <= 20; part++) {
      const page = readThreadPage({ threadId: 'other', source: source1, pageChars: 120, part });
      parts.push(page);
      if (page.includes('(end of thread)')) break;
    }
    // Every line of the message is on some part.
    for (let i = 0; i < 50; i++) expect(parts.some((page) => page.includes(`line ${i}\n`) || page.includes(`line ${i}`))).toBe(true);
  });

  it('handles an empty thread, a running one and a start past the end', () => {
    expect(readThreadPage({ threadId: 'other', source: source([], true) })).toMatch(/no messages yet\. A run is in progress/);
    expect(readThreadPage({ threadId: 'other', source: source(rows), from: 9 })).toMatch(/^Error: from=9 is past the end/);
  });
});

describe('read_thread tool', () => {
  it('refuses the current thread and unknown ids', async () => {
    const tool = createReadThreadTool({ read: async () => null, currentThreadId: 'current' });
    expect(await tool.execute({ thread_id: 'current' }, ctx)).toMatch(/already above/);
    expect(await tool.execute({ thread_id: 'gone' }, ctx)).toMatch(/no thread with id gone/);
    expect(await tool.execute({}, ctx)).toMatch(/needs a thread_id/);
  });

  it('reads a thread the host finds', async () => {
    const tool = createReadThreadTool({
      read: async (id) => (id === 'other' ? source([row(1, { role: 'user', content: 'hello' })]) : null),
    });
    const result = await tool.execute({ thread_id: 'other' }, ctx);
    expect(result).toContain('## [1] User\nhello');
    expect(result).toContain('(end of thread)');
  });
});
