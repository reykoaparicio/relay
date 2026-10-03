import { describe, expect, it } from 'vitest';
import { outputLimitNote, reservationText } from './RunActionDialogs';

describe('choose-profile option texts (L-1)', () => {
  it('notes a lowered output limit; nothing when the limit stays', () => {
    expect(outputLimitNote({ outputLimitLoweredTo: 64_000 })).toBe(' · output limit lowered to 64,000');
    expect(outputLimitNote({})).toBe('');
  });

  it('keeps the reservation wording', () => {
    expect(reservationText({ basis: 'minimum', reservationMicrousd: 80_000 as never })).toMatch(/^reserves at least ≈ \$/);
    expect(reservationText({ basis: 'step_estimate', reservationMicrousd: 80_000 as never })).toMatch(/^reserves ≈ \$/);
  });
});
