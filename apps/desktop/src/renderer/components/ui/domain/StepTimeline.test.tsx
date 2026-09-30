import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { step } from '../test-fixtures';
import { StepTimeline } from './StepTimeline';

const STEPS = [
  step(1, { stepKey: 'review' }),
  step(2, { stepKey: 'plan', state: 'awaiting_approval' }),
  step(3, { stepKey: 'patch', state: 'failed' }),
];

function Harness() {
  const [selected, setSelected] = useState<string>(STEPS[0]!.id);
  return <StepTimeline steps={STEPS} selectedId={selected} onSelect={setSelected} />;
}

describe('StepTimeline', () => {
  it('renders an ordered list with the state as text for every step', () => {
    render(<Harness />);

    expect(screen.getByRole('list', { name: 'Run steps' }).tagName).toBe('OL');
    expect(screen.getByRole('button', { name: /Plan.*Awaiting your approval/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Patch.*Failed/ })).toBeInTheDocument();
  });

  it('marks the selected step with aria-current="step" and moves it with arrow keys', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const review = screen.getByRole('button', { name: /^Review/ });

    expect(review).toHaveAttribute('aria-current', 'step');

    await user.click(review);
    await user.keyboard('{ArrowDown}');

    const plan = screen.getByRole('button', { name: /^Plan/ });
    expect(plan).toHaveAttribute('aria-current', 'step');
    expect(plan).toHaveFocus();

    await user.keyboard('{End}');
    expect(screen.getByRole('button', { name: /^Patch/ })).toHaveAttribute('aria-current', 'step');
  });
});
