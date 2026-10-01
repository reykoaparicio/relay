import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { COST_CERTAINTY } from '@relay/contracts';
import type { CostSummary, Microusd } from '@relay/contracts';
import { certaintyTagClass, RunCost } from './run-display';

const usd = (n: number) => n as Microusd;

describe('certaintyTagClass', () => {
  it('gives every certainty its own tone class, so an unknown charge gets the unknown tone', () => {
    const classes = COST_CERTAINTY.map(certaintyTagClass);

    expect(certaintyTagClass('unknown')).toBe('tag certainty-unknown');
    expect(new Set(classes).size).toBe(COST_CERTAINTY.length);
  });
});

describe('RunCost', () => {
  it('tags a calculated total with the calculated tone', () => {
    const cost = {
      settledReported: usd(0), settledCalculated: usd(120_000), settledEstimated: usd(0), reserved: usd(0), unknown: usd(0),
    } as unknown as CostSummary;

    render(<RunCost cost={cost} />);

    expect(screen.getByText('calculated')).toHaveClass('tag', 'certainty-calculated');
  });
});
