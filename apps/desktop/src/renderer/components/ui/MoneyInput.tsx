import type { ReactNode } from 'react';
import { usd } from '@relay/contracts';
import type { Microusd } from '@relay/contracts';
import { Field } from './Field';

/** Plain digits ("1000.50") or comma thousands groups ("1,000.50"); a comma anywhere else ("3,50") is rejected. */
const DOLLAR_PATTERN = /^(?:\d{1,9}|\d{1,3}(?:,\d{3}){1,2})(?:\.\d{1,6})?$/;

export type MoneyParseResult = { readonly ok: true; readonly value: Microusd } | { readonly ok: false; readonly message: string };

/**
 * Parses a dollar string ("3.50", "$3.50") into integer micro-USD through contracts `usd()`,
 * which never uses floats (§9.2). Returns a plain-language message on failure.
 */
export function parseDollarInput(text: string): MoneyParseResult {
  const trimmed = text.trim().replace(/^\$/, '');
  if (trimmed === '') return { ok: false, message: 'Enter an amount in US dollars, for example 3.50.' };
  if (!DOLLAR_PATTERN.test(trimmed)) {
    return {
      ok: false,
      message: 'Use a positive amount with at most 6 decimal places and commas only between thousands, for example 1,000.50.',
    };
  }
  // Commas are validated as thousands separators above, so removing them cannot change the amount.
  const digits = trimmed.replaceAll(',', '');
  try {
    return { ok: true, value: usd(digits as `${number}`) };
  } catch {
    return { ok: false, message: 'That amount is too large.' };
  }
}

export interface MoneyInputProps {
  readonly label: ReactNode;
  readonly value: string;
  /** Called on every edit with the raw text and the parsed amount (null while invalid). */
  readonly onValueChange: (text: string, parsed: Microusd | null) => void;
  readonly hint?: ReactNode;
  /** External error (e.g. server validation); a parse error takes precedence. */
  readonly error?: ReactNode;
  readonly required?: boolean;
  readonly id?: string;
  /** Show the parse error only after the user has interacted (default true). */
  readonly validateEmpty?: boolean;
}

export function MoneyInput({ label, value, onValueChange, hint, error, required = false, id, validateEmpty = false }: MoneyInputProps) {
  const result = parseDollarInput(value);
  const shownError = !result.ok && (value.trim() !== '' || validateEmpty) ? result.message : error;
  return (
    <Field
      label={label}
      hint={hint}
      error={shownError}
      required={required}
      {...(id === undefined ? {} : { id })}
    >
      {(control) => (
        <span className="money-input">
          <span className="prefix" aria-hidden="true">
            $
          </span>
          <input
            {...control}
            className="input mono"
            type="text"
            inputMode="decimal"
            autoComplete="off"
            value={value}
            onChange={(e) => {
              const parsed = parseDollarInput(e.target.value);
              onValueChange(e.target.value, parsed.ok ? parsed.value : null);
            }}
          />
        </span>
      )}
    </Field>
  );
}
