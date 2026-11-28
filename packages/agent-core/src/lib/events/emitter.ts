import type { AgentEvent, AgentEventWithoutSeq } from '@agent/agent-models';

import type { EventSubscriber } from './types';

export type { EventSubscriber } from './types';

/** Safety cap on a run's buffer; past it the oldest events drop and a gap is recovered from the ledger. */
export const MAX_BUFFERED_EVENTS = 5_000;

/**
 * In-memory event emitter with monotonic seq counters and the buffer a
 * reconnecting SSE client replays from.
 *
 * One emitter per run. A replay from any cursor rebuilds the same live view:
 * every event is kept, except the deltas of a message once its
 * `assistant.completed` arrives (that event carries the full text, so its
 * deltas say nothing more). The buffer is therefore the run's structural
 * events plus the one message being streamed.
 */
export class EventEmitter {
  private seq = 0;
  private buffer: AgentEvent[] = [];
  private subscribers = new Set<EventSubscriber>();

  /** Emit an event. Assigns seq, buffers, and fans out to subscribers. */
  emit(event: AgentEventWithoutSeq): void {
    const seq = ++this.seq;
    const fullEvent = { seq, ...event } as AgentEvent;
    if (fullEvent.type === 'assistant.completed') {
      const { messageId } = fullEvent;
      this.buffer = this.buffer.filter((e) => e.type !== 'assistant.delta' || e.messageId !== messageId);
    }
    this.buffer.push(fullEvent);
    if (this.buffer.length > MAX_BUFFERED_EVENTS) {
      this.buffer.shift();
    }
    for (const sub of this.subscribers) {
      sub(fullEvent);
    }
  }

  /** Subscribe to live events. Returns an unsubscribe function. */
  subscribe(subscriber: EventSubscriber): () => void {
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  /** Get buffered events after the given seq (for replay on reconnect). */
  getEventsFromSeq(fromSeq: number): AgentEvent[] {
    return this.buffer.filter((e) => e.seq > fromSeq);
  }

  /** All buffered events. */
  getBuffer(): AgentEvent[] {
    return [...this.buffer];
  }

  /** The newest event, if any is buffered. */
  get lastEvent(): AgentEvent | undefined {
    return this.buffer.at(-1);
  }

  /** Current seq (for clients to track their cursor). */
  get currentSeq(): number {
    return this.seq;
  }

  /** Clear the buffer (call after run completes and clients have persisted). */
  dispose(): void {
    this.buffer = [];
    this.subscribers.clear();
  }
}
