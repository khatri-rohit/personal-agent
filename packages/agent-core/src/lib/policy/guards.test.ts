import { describe, expect, it } from 'vitest';

import { readStormAction, repeatAction, reportOnlyCall } from './guards';

describe('repeatAction', () => {
  it('runs up to the limit, and always runs exec', () => {
    expect(repeatAction({ count: 3, limit: 3, stage: 'read' })).toBe('run');
    expect(repeatAction({ count: 50, limit: 3, stage: 'exec' })).toBe('run');
  });
  it('answers read and network repeats from earlier up to twice the limit, then halts', () => {
    expect(repeatAction({ count: 4, limit: 3, stage: 'read' })).toBe('answer');
    expect(repeatAction({ count: 6, limit: 3, stage: 'network' })).toBe('answer');
    expect(repeatAction({ count: 7, limit: 3, stage: 'read' })).toBe('halt');
  });
  it('halts other stages past the limit', () => {
    expect(repeatAction({ count: 4, limit: 3, stage: 'mutate' })).toBe('halt');
  });
});

describe('readStormAction', () => {
  it('runs reads of one file up to the limit, answers them up to twice the limit, then halts', () => {
    expect(readStormAction({ attempts: 30, limit: 30 })).toBe('run');
    expect(readStormAction({ attempts: 31, limit: 30 })).toBe('answer');
    expect(readStormAction({ attempts: 60, limit: 30 })).toBe('answer');
    expect(readStormAction({ attempts: 61, limit: 30 })).toBe('halt');
  });
});

describe('reportOnlyCall', () => {
  const base = { toolName: 'grep', hasReport: true, maxToolCalls: 11, used: 10 };
  it('refuses everything but report once only the reserved call is left', () => {
    expect(reportOnlyCall(base)).toBe(true);
    expect(reportOnlyCall({ ...base, toolName: 'report' })).toBe(false);
    expect(reportOnlyCall({ ...base, used: 9 })).toBe(false);
  });
  it('never applies to a run without a report tool or a call cap', () => {
    expect(reportOnlyCall({ ...base, hasReport: false })).toBe(false);
    expect(reportOnlyCall({ ...base, maxToolCalls: undefined })).toBe(false);
  });
});
