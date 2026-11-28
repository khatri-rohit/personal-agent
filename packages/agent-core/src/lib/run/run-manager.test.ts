import { describe, expect, it } from 'vitest';

import { RunManager } from './run-manager';
import type { StartRunOptions } from './types';

describe('RunManager late subscribers', () => {
  it('answers a cleared run with its run.settled, and an unknown run with null', async () => {
    const runs = new RunManager();
    const claimed = runs.claim('thread-1');
    if (!claimed.ok) throw new Error('claim refused');
    const { runId } = claimed.claim;
    // Cancelled before it starts: the loop is skipped, the run still settles.
    runs.cancel(runId);
    claimed.claim.start({} as StartRunOptions, { retainMs: 0 });
    await runs.wait(runId);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const late = runs.subscribe(runId, 0, () => undefined);
    expect(late?.live).toBe(false);
    expect(late?.replay.map((event) => event.type)).toEqual(['run.settled']);
    expect(late?.replay[0]).toMatchObject({ cancelled: true });

    const end = late?.replay[0]?.seq ?? 0;
    expect(runs.subscribe(runId, end, () => undefined)?.replay).toEqual([]);
    expect(runs.subscribe('never-ran', 0, () => undefined)).toBeNull();
  });
});
