import { describe, expect, it } from 'vitest';
import { appError } from './errors.js';
import { runnerMessageSchema, runnerRequestSchema } from './runner-protocol.js';
import { fakeId, runEventFixture } from './test-fixtures.js';

describe('runnerRequestSchema', () => {
  it('op requests accept an internal channel and reject a main-route channel', () => {
    const internal = { kind: 'op', id: '1', channel: 'relay/v1/projects.createFromRoot', input: {} };
    const forwarded = { kind: 'op', id: '2', channel: 'relay/v1/providers.test', input: {} };
    const mainOnly = { kind: 'op', id: '3', channel: 'relay/v1/app.getInfo', input: {} };

    expect(runnerRequestSchema.safeParse(internal).success).toBe(true);
    expect(runnerRequestSchema.safeParse(forwarded).success).toBe(true);
    expect(runnerRequestSchema.safeParse(mainOnly).success).toBe(false);
  });

  it('accepts credential responses and bounded shutdowns', () => {
    expect(
      runnerRequestSchema.safeParse({ kind: 'credential.response', id: 'c1', result: { ok: true, apiKey: 'k' } }).success,
    ).toBe(true);
    expect(
      runnerRequestSchema.safeParse({
        kind: 'credential.response',
        id: 'c1',
        result: { ok: false, error: appError('AUTH_REQUIRED') },
      }).success,
    ).toBe(true);
    expect(runnerRequestSchema.safeParse({ kind: 'shutdown', graceMs: 10_001 }).success).toBe(false);
    expect(runnerRequestSchema.safeParse({ kind: 'shutdown', graceMs: 5_000 }).success).toBe(true);
  });
});

describe('runnerMessageSchema', () => {
  it('credential.request requires purpose and accepts attemptId null', () => {
    const base = { kind: 'credential.request', id: 'r1', providerId: 'anthropic' };

    expect(runnerMessageSchema.safeParse({ ...base, purpose: 'dispatch', attemptId: null }).success).toBe(true);
    expect(runnerMessageSchema.safeParse({ ...base, purpose: 'connection_test', attemptId: fakeId('attempt') }).success).toBe(
      true,
    );
    expect(runnerMessageSchema.safeParse({ ...base, attemptId: null }).success).toBe(false);
    expect(runnerMessageSchema.safeParse({ ...base, purpose: 'exfiltrate', attemptId: null }).success).toBe(false);
  });

  it('parses ready, op.result, heartbeat, event, and fatal messages', () => {
    const messages = [
      { kind: 'ready', schemaVersion: 1, pid: 123 },
      { kind: 'op.result', id: 'x', result: { ok: true, data: null } },
      { kind: 'op.result', id: 'y', result: { ok: false, error: appError('NOT_FOUND') } },
      { kind: 'heartbeat', at: 1, activeRunId: null },
      { kind: 'event', event: { type: 'run.event', event: runEventFixture() } },
      { kind: 'fatal', code: 'INTERNAL', message: 'migration failed' },
    ];

    for (const m of messages) expect(runnerMessageSchema.safeParse(m).success).toBe(true);
    expect(runnerMessageSchema.safeParse({ kind: 'fatal', code: 'BOOM', message: '' }).success).toBe(false);
  });
});
