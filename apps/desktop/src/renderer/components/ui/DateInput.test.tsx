import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { parseDateInput } from '../../lib/format';
import { DateInput, INCOMPLETE_DATE } from './DateInput';
import { Field } from './Field';

function Harness({ onChange, initial = '2026-09-27' }: { readonly onChange: (v: string) => void; readonly initial?: string }) {
  const [value, setValue] = useState(initial);
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

/** jsdom has no partial date entry: stub what Chromium reports for one (value '', validity.badInput). */
function enterPartialDate(input: HTMLElement) {
  Object.defineProperty(input, 'validity', { configurable: true, value: { badInput: true } });
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

  it('reports a partly typed date as incomplete (rejected by parseDateInput), not as "no date"', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const input = screen.getByLabelText('Review date');

    enterPartialDate(input);
    fireEvent.change(input, { target: { value: '' } });

    expect(onChange).toHaveBeenLastCalledWith(INCOMPLETE_DATE);
    expect(parseDateInput(INCOMPLETE_DATE)).toBeUndefined();
    expect(input).toHaveValue(''); // the DOM keeps the partial entry (React writes nothing over it)
  });

  it('a first partial entry (no change event) is reported when the field is left', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} initial="" />);
    const input = screen.getByLabelText('Review date');

    fireEvent.blur(input);
    expect(onChange).not.toHaveBeenCalled(); // still empty: nothing to report

    enterPartialDate(input);
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledWith(INCOMPLETE_DATE);
  });

  it('clearing the date completely is still "no date"', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('Review date'), { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith('');
  });
});
