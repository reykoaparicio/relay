import type { ReactNode } from 'react';
import { API_KEY_LENGTH } from '@relay/contracts';
import { Field, TextInput } from '../../components/ui';

export interface ApiKeyFieldProps {
  readonly label?: string;
  readonly value: string;
  readonly onValueChange: (v: string) => void;
  readonly hint: ReactNode;
  readonly error?: string | null;
  readonly id?: string;
  readonly disabled?: boolean;
}

/** Client check before the key leaves the form (the main process validates again). */
export function apiKeyError(key: string): string | null {
  const n = key.trim().length;
  if (n === 0) return 'Paste the API key from your provider console.';
  if (n < API_KEY_LENGTH.min)
    return `That key looks too short (at least ${String(API_KEY_LENGTH.min)} characters).`;
  if (n > API_KEY_LENGTH.max) return 'That key is too long. Check that only the key was pasted.';
  return null;
}

/** Masked key input (FR-02): `type=password`, no autocomplete or spellcheck. The value is cleared on submit. */
export function ApiKeyField({
  label = 'API key',
  value,
  onValueChange,
  hint,
  error = null,
  id,
  disabled = false,
}: ApiKeyFieldProps) {
  return (
    <Field label={label} hint={hint} error={error} required {...(id === undefined ? {} : { id })}>
      {(control) => (
        <TextInput
          {...control}
          type="password"
          mono
          autoComplete="off"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          disabled={disabled}
          value={value}
          onValueChange={onValueChange}
        />
      )}
    </Field>
  );
}
