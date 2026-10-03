// Settings → About: the theme (`app.updateSettings({ theme })`). System follows the OS (the engine default).
import { useId } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { AppSettings } from '@relay/contracts';
import { ErrorView, Field, Select } from '../../components/ui';
import { call } from '../../api/client';
import { toViewError } from '../../api/errors';
import { qk } from '../../api/keys';
import { useSettings } from '../../hooks/useSettings';

type Theme = AppSettings['theme'];

const THEME_OPTIONS: ReadonlyArray<{ readonly value: Theme; readonly label: string }> = [
  { value: 'system', label: 'Match the system' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

function isTheme(v: string): v is Theme {
  return THEME_OPTIONS.some((o) => o.value === v);
}

export function AppearanceCard() {
  const titleId = useId();
  const fieldId = useId();
  const queryClient = useQueryClient();
  const settings = useSettings();
  const save = useMutation({
    mutationFn: (theme: Theme) => call('relay/v1/app.updateSettings', { theme }),
    onMutate: (theme) => {
      // Applied at once; a failed save puts the previous theme back.
      const previous = queryClient.getQueryData<AppSettings>(qk.settings());
      if (previous !== undefined) queryClient.setQueryData<AppSettings>(qk.settings(), { ...previous, theme });
      return { previous };
    },
    onError: (_e, _theme, context) => {
      if (context?.previous !== undefined) queryClient.setQueryData(qk.settings(), context.previous);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: qk.settings() }),
  });
  return (
    <section className="card stack" aria-labelledby={titleId}>
      <h2 id={titleId}>Appearance</h2>
      <Field label="Theme" id={fieldId} hint="Match the system follows your operating system's light or dark setting.">
        {(control) => (
          <Select
            {...control}
            value={settings.data?.theme ?? 'system'}
            disabled={settings.data === undefined}
            options={THEME_OPTIONS}
            style={{ maxWidth: 320 }}
            onValueChange={(v) => {
              if (isTheme(v)) save.mutate(v);
            }}
          />
        )}
      </Field>
      {save.error === null ? null : <ErrorView live="assertive" error={toViewError(save.error)} onAction={() => { save.reset(); }} />}
    </section>
  );
}
