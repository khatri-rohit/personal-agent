import { describe, expect, it } from 'vitest';

import { EventEmitter, MAX_BUFFERED_EVENTS } from './emitter';

describe('EventEmitter', () => {
  it('assigns monotonic seq and keeps a bounded ring', () => {
    const emitter = new EventEmitter();
    const extra = 3;
    for (let i = 0; i < MAX_BUFFERED_EVENTS + extra; i++) {
      emitter.emit({ type: 'run.settled', runId: 'r1' });
    }

    const buffer = emitter.getBuffer();
    expect(buffer).toHaveLength(MAX_BUFFERED_EVENTS);
    expect(buffer[0]?.seq).toBe(extra + 1);
    expect(buffer[buffer.length - 1]?.seq).toBe(MAX_BUFFERED_EVENTS + extra);
    expect(emitter.currentSeq).toBe(MAX_BUFFERED_EVENTS + extra);
  });

  it('drops a message\'s deltas once it completes, and keeps everything else', () => {
    const emitter = new EventEmitter();
    emitter.emit({ type: 'assistant.started', runId: 'r1', messageId: 'm1' });
    emitter.emit({ type: 'assistant.delta', runId: 'r1', messageId: 'm1', delta: 'Hel' });
    emitter.emit({ type: 'assistant.delta', runId: 'r1', messageId: 'm1', delta: 'lo' });
    emitter.emit({ type: 'assistant.started', runId: 'r1', messageId: 'm2' });
    emitter.emit({ type: 'assistant.delta', runId: 'r1', messageId: 'm2', delta: 'Wor' });
    emitter.emit({ type: 'assistant.completed', runId: 'r1', messageId: 'm1', content: 'Hello' });

    expect(emitter.getBuffer().map((e) => e.seq)).toEqual([1, 4, 5, 6]);
    expect(emitter.lastEvent?.type).toBe('assistant.completed');
  });

  it('replays only seqs after fromSeq', () => {
    const emitter = new EventEmitter();
    emitter.emit({ type: 'run.settled', runId: 'r1' });
    emitter.emit({ type: 'run.settled', runId: 'r1' });
    emitter.emit({ type: 'run.settled', runId: 'r1' });

    expect(emitter.getEventsFromSeq(1).map((e) => e.seq)).toEqual([2, 3]);
  });
});
