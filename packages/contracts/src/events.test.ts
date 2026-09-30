import { describe, expect, it } from 'vitest';
import { RUN_EVENT_TYPES } from './domain/event.js';
import { pushEventSchema } from './events.js';
import { fakeId, runEventFixture } from './test-fixtures.js';

describe('pushEventSchema', () => {
  it.each(RUN_EVENT_TYPES)('parses a run.event of type %s', (type) => {
    expect(pushEventSchema.safeParse({ type: 'run.event', event: runEventFixture(type) }).success).toBe(true);
  });

  it('parses the other push event types and rejects unknown ones', () => {
    const events = [
      { type: 'run.status', runId: fakeId('run'), status: 'paused', pauseReason: 'user', seq: 3 },
      { type: 'runner.state', state: 'restarting' },
      { type: 'memory.changed', projectId: fakeId('project') },
      { type: 'providers.changed' },
    ];

    for (const e of events) expect(pushEventSchema.safeParse(e).success).toBe(true);
    expect(pushEventSchema.safeParse({ type: 'run.event', event: runEventFixture('run.exploded') }).success).toBe(false);
    expect(pushEventSchema.safeParse({ type: 'nope' }).success).toBe(false);
  });
});
