import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { DateInput } from './DateInput';
import { Field } from './Field';

function Harness({ onChange }: { readonly onChange: (v: string) => void }) {
  const [value, setValue] = useState('2026-09-27');
  return (
    <Field label="Review date" id="review" error="Use a valid date">
      {(control) => (
        <DateInput
          {...control}
          value={value}
          onValueChange={(v) => {
            setValue(v);
            onChange(v);
          }}
        />
      )}
    </Field>
  );
}

describe('DateInput', () => {
  it('is a labelled, controlled date input wired to the field error', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const input = screen.getByLabelText('Review date');

    fireEvent.change(input, { target: { value: '2026-10-01' } });

    expect(input).toHaveAttribute('type', 'date');
    expect(input).toHaveValue('2026-10-01');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(onChange).toHaveBeenCalledWith('2026-10-01');
  });
});
