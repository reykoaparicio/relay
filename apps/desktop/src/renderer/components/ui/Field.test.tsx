import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Field } from './Field';

describe('Field', () => {
  it('associates the label with the control', () => {
    render(<Field label="Run allowance">{(control) => <input {...control} />}</Field>);

    expect(screen.getByLabelText('Run allowance')).toBeInstanceOf(HTMLInputElement);
  });

  it('describes the control by its hint', () => {
    render(
      <Field label="Goal" hint="One sentence is enough">
        {(control) => <input {...control} />}
      </Field>,
    );

    expect(screen.getByLabelText('Goal')).toHaveAccessibleDescription('One sentence is enough');
    expect(screen.getByLabelText('Goal')).not.toHaveAttribute('aria-invalid');
  });

  it('adds the error id to aria-describedby and sets aria-invalid when there is an error', () => {
    render(
      <Field label="Goal" hint="One sentence is enough" error="Enter a goal">
        {(control) => <input {...control} />}
      </Field>,
    );
    const input = screen.getByLabelText('Goal');
    const errorId = screen.getByText('Enter a goal').closest('.error')?.id ?? '';

    expect(errorId).not.toBe('');
    expect(input.getAttribute('aria-describedby')?.split(' ')).toContain(errorId);
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription('One sentence is enough Enter a goal');
  });
});
