import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import { ERROR_CODES, RUN_ACTIONS } from '../status.js';
import {
  FORWARDED_COMPOSITE_CHANNELS,
  getOperation,
  getRunnerOperation,
  INTERNAL_OPERATION_LIST,
  isChannel,
  OPERATION_LIST,
  OPERATIONS,
  RUN_ACTION_OPS,
  RUNNER_CHANNELS,
  runnerChannelSchema,
} from './catalog.js';
import type { RunId } from '../ids.js';
import type { Channel, InputOf, IpcResult, OutputOf, RunnerChannel } from './catalog.js';
import type { AnyOperationDef } from './common.js';
import { INTERNAL_RUNNER_OPS } from './internal.js';

const CHANNEL_RE = /^relay\/v1\/[a-z]+\.[a-zA-Z]+$/;

function hasIdempotencyKey(schema: z.ZodType): boolean {
  return schema instanceof z.ZodObject && 'idempotencyKey' in schema.shape;
}

describe('OPERATIONS / INTERNAL_RUNNER_OPS', () => {
  const all: readonly AnyOperationDef[] = [...OPERATION_LIST, ...INTERNAL_OPERATION_LIST];

  it('has at least 55 renderer ops and 10 internal ops', () => {
    expect(OPERATION_LIST.length).toBeGreaterThanOrEqual(55);
    expect(INTERNAL_OPERATION_LIST).toHaveLength(10);
    expect(INTERNAL_OPERATION_LIST.map((d) => d.channel)).toContain('relay/v1/projects.relocateRoot');
    const renderer = OPERATION_LIST.map((d) => d.channel);
    for (const c of ['app.restartRunner', 'app.relaunch', 'app.restoreLatestBackup', 'projects.relocate', 'projects.unarchive']) {
      expect(renderer).toContain(`relay/v1/${c}`);
    }
  });

  it('every channel is unique across both sets and well-formed', () => {
    const channels = all.map((d) => d.channel);

    expect(new Set(channels).size).toBe(channels.length);
    for (const c of channels) expect(c).toMatch(CHANNEL_RE);
  });

  it('keys match their channel', () => {
    for (const [key, def] of [...Object.entries(OPERATIONS), ...Object.entries(INTERNAL_RUNNER_OPS)]) {
      expect(def.channel).toBe(`relay/v1/${key}`);
    }
  });

  it('no internal op appears in OPERATIONS (by key and by channel)', () => {
    const opChannels = new Set(OPERATION_LIST.map((d) => d.channel));

    for (const [key, def] of Object.entries(INTERNAL_RUNNER_OPS)) {
      expect(key in OPERATIONS).toBe(false);
      expect(opChannels.has(def.channel)).toBe(false);
      expect(isChannel(def.channel)).toBe(false);
      expect(def.route).toBe('runner');
    }
  });

  it('idempotent ops are commands with an idempotencyKey in their input (both sets)', () => {
    for (const d of all) {
      if (d.idempotent) {
        expect(d.kind, d.channel).toBe('command');
        expect(hasIdempotencyKey(d.input), d.channel).toBe(true);
      } else {
        expect(hasIdempotencyKey(d.input), d.channel).toBe(false);
      }
    }
  });

  it("every op's errors are ErrorCodes", () => {
    for (const d of all) {
      for (const e of d.errors) expect(ERROR_CODES).toContain(e);
      expect(new Set(d.errors).size, d.channel).toBe(d.errors.length);
    }
  });

  it('providers.test documents BUDGET_BLOCKED and connect/disconnect are main+runner', () => {
    expect(OPERATIONS['providers.test'].errors).toContain('BUDGET_BLOCKED');
    expect(OPERATIONS['providers.connect'].route).toBe('main+runner');
    expect(OPERATIONS['providers.disconnect'].route).toBe('main+runner');
  });

  it('FORWARDED_COMPOSITE_CHANNELS are main+runner ops', () => {
    for (const c of FORWARDED_COMPOSITE_CHANNELS) expect(getOperation(c)?.route).toBe('main+runner');
  });

  it('declares the B6 rate limits', () => {
    expect(OPERATIONS['providers.test'].rateLimit).toEqual({ capacity: 5, refillPerSec: 1 / 12 });
    expect(OPERATIONS['runs.start'].rateLimit?.capacity).toBe(10);
    expect(OPERATIONS['artifacts.export'].rateLimit?.capacity).toBe(5);
    for (const d of INTERNAL_OPERATION_LIST) expect(d.rateLimit).toBeUndefined();
  });

  it('z.toJSONSchema(input, { io: "input" }) succeeds for every OPERATIONS op', () => {
    for (const d of OPERATION_LIST) {
      expect(() => z.toJSONSchema(d.input, { io: 'input' }), d.channel).not.toThrow();
    }
  });

  it('renderer DTOs carry no realpath fields; internal ops do', () => {
    const json = (d: AnyOperationDef) =>
      JSON.stringify([z.toJSONSchema(d.input, { io: 'input' }), z.toJSONSchema(d.output, { io: 'input' })]);

    for (const d of OPERATION_LIST) expect(json(d), d.channel).not.toMatch(/[Rr]ealpath/);
    expect(json(INTERNAL_RUNNER_OPS['projects.createFromRoot'])).toContain('rootRealpath');
  });
});

describe('runner channels', () => {
  it('include runner-routed, forwarded, and internal channels only', () => {
    const expected = [
      ...OPERATION_LIST.filter((d) => d.route === 'runner').map((d) => d.channel),
      ...FORWARDED_COMPOSITE_CHANNELS,
      ...INTERNAL_OPERATION_LIST.map((d) => d.channel),
    ];

    expect([...RUNNER_CHANNELS].sort()).toEqual([...expected].sort());
    expect(runnerChannelSchema.safeParse('relay/v1/app.getInfo').success).toBe(false);
    expect(runnerChannelSchema.safeParse('relay/v1/projects.createFromRoot').success).toBe(true);
    expect(getRunnerOperation('relay/v1/providers.test')?.route).toBe('main+runner');
    expect(getRunnerOperation('relay/v1/app.getInfo')).toBeUndefined();
    expect(isChannel(42)).toBe(false);
    expect(isChannel('relay/v1/runs.start')).toBe(true);
  });
});

describe('RUN_ACTION_OPS', () => {
  it('covers every RUN_ACTIONS member with a Channel, a non-empty Channel list, or navigate', () => {
    expect(Object.keys(RUN_ACTION_OPS).sort()).toEqual([...RUN_ACTIONS].sort());
    for (const action of RUN_ACTIONS) {
      const target: unknown = RUN_ACTION_OPS[action];
      if (target === 'navigate') continue;
      const channels = Array.isArray(target) ? (target as unknown[]) : [target];
      expect(channels.length, action).toBeGreaterThan(0);
      for (const c of channels) expect(isChannel(c), `${action} → ${String(c)}`).toBe(true);
    }
  });

  it('maps choose_profile to exactly runs.retryStep and runs.resume', () => {
    expect(RUN_ACTION_OPS.choose_profile).toEqual(['relay/v1/runs.retryStep', 'relay/v1/runs.resume']);
    expect(RUN_ACTION_OPS.reconnect_provider).toBe('navigate');
  });
});

describe('channel types', () => {
  it('are literal unions with typed input and output', () => {
    expectTypeOf<'relay/v1/runs.start'>().toExtend<Channel>();
    expectTypeOf<'relay/v1/projects.createFromRoot'>().not.toExtend<Channel>();
    expectTypeOf<'relay/v1/projects.createFromRoot'>().toExtend<RunnerChannel>();
    expectTypeOf<'relay/v1/providers.test'>().toExtend<RunnerChannel>();
    expectTypeOf<'relay/v1/app.getInfo'>().not.toExtend<RunnerChannel>();
    expectTypeOf<InputOf<'relay/v1/runs.start'>['goal']>().toEqualTypeOf<string>();
    expectTypeOf<OutputOf<'relay/v1/runs.get'>['id']>().toEqualTypeOf<RunId>();
    expectTypeOf<
      Extract<IpcResult<'relay/v1/runs.start'>, { ok: true }>['data']['runId']
    >().toEqualTypeOf<RunId>();
  });
});
