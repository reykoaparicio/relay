import { describe, expect, it } from 'vitest';
import { invariant, assertNever } from './assert.js';
import { epochMs, systemClock } from './time.js';

describe('time', () => {
  it('systemClock returns the current epoch ms', () => {
    const before = Date.now();

    const now = systemClock.now();

    expect(now).toBeGreaterThanOrEqual(before);
    expect(Number.isInteger(now)).toBe(true);
  });

  it('epochMs rejects negatives and floats', () => {
    expect(epochMs(5)).toBe(5);
    expect(() => epochMs(-1)).toThrow(RangeError);
    expect(() => epochMs(1.2)).toThrow(RangeError);
  });
});

describe('assert', () => {
  it('assertNever always throws, with the default or a custom message', () => {
    expect(() => assertNever('x' as never)).toThrow('Unexpected value: "x"');
    expect(() => assertNever('x' as never, 'boom')).toThrow('boom');
  });

  it('invariant throws only on falsy conditions', () => {
    expect(() => {
      invariant(1, 'fine');
    }).not.toThrow();
    expect(() => {
      invariant(0, 'bad');
    }).toThrow('Invariant violation: bad');
  });
});
