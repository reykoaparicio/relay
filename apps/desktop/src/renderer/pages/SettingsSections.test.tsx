import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { appError } from '@relay/contracts';
import { createFakeBridge, FAKE_PROJECT_ID, FAKE_WORKFLOW_ID } from '../api/fake-bridge';
import { recentMonths } from '../features/settings/DataSection';
import { sid } from '../api/fake-scenarios/world';
import { renderApp } from '../features/testing/render-app';

const NOT_IMPLEMENTED = (channel: string) =>
  appError('INTERNAL', {
    userMessage: 'This feature is not available in this build yet.',
    details: { reason: 'not_implemented', channel },
  });

async function section(name: string) {
  await screen.findByRole('heading', { level: 1, name: 'Settings' });
  return screen.findByRole('heading', { level: 2, name });
}

describe('Settings → Model profiles (J10)', () => {
  it('lists profiles with the engine capability check and creates a profile via profiles.upsert', async () => {
    const user = userEvent.setup();
    const { bridge } = renderApp('/settings/profiles', { scenario: 'awaiting-approval' });
    await section('Model profiles');
    const table = await screen.findByRole('table', { name: 'Model profiles' });
    expect(within(table).getByRole('rowheader', { name: 'Economy' })).toBeInTheDocument();
    expect(within(table).getAllByText('OK').length).toBe(3);

    await user.click(screen.getByRole('button', { name: 'Add profile' }));
    const form = screen.getByRole('form', { name: 'New profile' });
    await user.click(within(form).getByRole('button', { name: 'Create profile' }));
    expect(within(form).getByText('Enter a profile name, for example Balanced.')).toBeInTheDocument();
    expect(bridge.callsTo('relay/v1/profiles.upsert')).toHaveLength(0);

    await user.type(within(form).getByRole('textbox', { name: /Name/ }), 'Thorough');
    await user.selectOptions(within(form).getByRole('combobox', { name: 'Provider' }), 'openai');
    await user.click(within(form).getByRole('button', { name: 'Create profile' }));
    await waitFor(() => {
      expect(bridge.callsTo('relay/v1/profiles.upsert')).toHaveLength(1);
    });
    expect(bridge.callsTo('relay/v1/profiles.upsert')[0]?.input).toMatchObject({
      profile: { name: 'Thorough', providerId: 'openai', modelId: 'gpt-5-mini', params: { maxOutputTokens: 8000 } },
    });
    expect(await screen.findByText(/Saved “Thorough” \(revision 1\)/)).toBeInTheDocument();
    expect(screen.getByText('No capability warnings.')).toBeInTheDocument();
  });

  it('edits with the expected revision and shows the warnings returned by the save', async () => {
    const user = userEvent.setup();
    const { bridge } = renderApp('/settings/profiles', { scenario: 'awaiting-approval' });
    await section('Model profiles');
    await user.click(await screen.findByRole('button', { name: 'Edit Balanced' }));
    const form = screen.getByRole('form', { name: 'Edit Balanced' });
    const tokens = within(form).getByRole('spinbutton', { name: /Default max output tokens/ });
    await user.clear(tokens);
    await user.type(tokens, '12000');
    bridge.failNext('relay/v1/profiles.upsert', appError('CONFLICT'));
    await user.click(within(form).getByRole('button', { name: 'Save revision 2' }));
    expect(await within(form).findByText('This item changed since it was loaded')).toBeInTheDocument();
    await user.click(within(form).getByRole('button', { name: 'Save revision 2' }));
    await waitFor(() => {
      expect(bridge.callsTo('relay/v1/profiles.upsert')).toHaveLength(2);
    });
    expect(bridge.callsTo('relay/v1/profiles.upsert')[1]?.input).toMatchObject({
      expectedRevision: 1,
      profile: { name: 'Balanced', params: { maxOutputTokens: 12000 } },
    });
    expect(await screen.findByText(/Saved “Balanced” \(revision 2\)/)).toBeInTheDocument();
  });

  it('deletes an unused profile only after the confirmation (profiles.delete)', async () => {
    const user = userEvent.setup();
    const bridge = createFakeBridge('awaiting-approval');
    const capable = bridge.world.profiles[2]!;
    bridge.world.profiles = [...bridge.world.profiles, { ...capable, profile: { ...capable.profile, id: sid('profile', 9) as typeof capable.profile.id, name: 'Spare' } }];
    renderApp('/settings/profiles', { bridge });
    await section('Model profiles');
    await user.click(await screen.findByRole('button', { name: 'Delete Spare' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete the “Spare” profile?' });
    expect(dialog).toHaveTextContent(/Past runs keep the profile snapshot/);
    expect(bridge.callsTo('relay/v1/profiles.delete')).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Delete profile' }));
    await waitFor(() => {
      expect(bridge.callsTo('relay/v1/profiles.delete')[0]?.input).toEqual({ profileId: sid('profile', 9) });
    });
    await waitFor(() => {
      expect(screen.queryByRole('rowheader', { name: 'Spare' })).not.toBeInTheDocument();
    });
  });

  it('B9: deleting a profile in use pre-warns with the workflows and shows profile_in_use (no Reload)', async () => {
    const user = userEvent.setup();
    const { bridge } = renderApp(`/settings/profiles?project=${FAKE_PROJECT_ID}`, { scenario: 'awaiting-approval' });
    await section('Model profiles');
    await user.click(await screen.findByRole('button', { name: 'Delete Capable' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete the “Capable” profile?' });
    expect(dialog).toHaveTextContent(/Relay refuses to delete a profile that a workflow draft or validated version still names/);
    expect(dialog).not.toHaveTextContent(/cannot be validated until you choose another profile/);
    expect(await within(dialog).findByText(/deleting will be refused/)).toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: 'Review & propose a fix (v3)' })).toHaveAttribute('href', `/p/${FAKE_PROJECT_ID}/workflows/${FAKE_WORKFLOW_ID}`);
    await user.click(within(dialog).getByRole('button', { name: 'Delete profile' }));
    expect(await within(dialog).findByText('This profile is used by workflows')).toBeInTheDocument();
    expect(dialog).toHaveTextContent(/Used by “Review & propose a fix”/);
    expect(within(dialog).queryByRole('button', { name: 'Reload' })).not.toBeInTheDocument();
    expect(bridge.world.profiles.some((p) => p.profile.name === 'Capable')).toBe(true);
  });

  it('B8: renaming a profile used by workflows pre-warns and shows the engine profile_in_use CONFLICT', async () => {
    const user = userEvent.setup();
    const { bridge } = renderApp('/settings/profiles', { scenario: 'awaiting-approval' });
    await section('Model profiles');
    await user.click(await screen.findByRole('button', { name: 'Edit Economy' }));
    const form = screen.getByRole('form', { name: 'Edit Economy' });
    const name = within(form).getByRole('textbox', { name: /Name/ });
    await user.clear(name);
    await user.type(name, 'Cheap');
    expect(await within(form).findByText('Relay will refuse to rename “Economy” while workflows use it')).toBeInTheDocument();
    await user.click(within(form).getByRole('button', { name: 'Save revision 2' }));
    expect(await within(form).findByText('This profile is used by workflows')).toBeInTheDocument();
    expect(within(form).queryByText(/Relay will refuse to rename/)).not.toBeInTheDocument();
    expect(within(form).getByRole('list', { name: 'Workflows using this profile' })).toHaveTextContent('Review & propose a fix (v3)');
    expect(within(form).queryByRole('button', { name: 'Reload' })).not.toBeInTheDocument();
    expect(bridge.world.profiles[0]?.profile.name).toBe('Economy');
  });

  it('a stale profile CONFLICT: Reload refetches the profiles and re-bases the expected revision', async () => {
    const user = userEvent.setup();
    const { bridge } = renderApp('/settings/profiles', { scenario: 'awaiting-approval' });
    await section('Model profiles');
    await user.click(await screen.findByRole('button', { name: 'Edit Balanced' }));
    const form = screen.getByRole('form', { name: 'Edit Balanced' });
    const tokens = within(form).getByRole('spinbutton', { name: /Default max output tokens/ });
    await user.clear(tokens);
    await user.type(tokens, '12000');
    bridge.world.profiles = bridge.world.profiles.map((p) => (p.profile.name === 'Balanced' ? { ...p, profile: { ...p.profile, revision: 2 } } : p));
    await user.click(within(form).getByRole('button', { name: 'Save revision 2' }));
    await user.click(await within(form).findByRole('button', { name: 'Reload' }));
    await user.click(await within(form).findByRole('button', { name: 'Save revision 3' }));
    await waitFor(() => {
      expect(bridge.callsTo('relay/v1/profiles.upsert')).toHaveLength(2);
    });
    expect(bridge.callsTo('relay/v1/profiles.upsert')[1]?.input).toMatchObject({ expectedRevision: 2, profile: { params: { maxOutputTokens: 12000 } } });
  });

  it('profiles.upsert failing as a stubbed channel: the generic ErrorView', async () => {
    const user = userEvent.setup();
    const { bridge } = renderApp('/settings/profiles', { scenario: 'awaiting-approval' });
    await section('Model profiles');
    bridge.world.notImplemented.add('profiles.upsert');
    await user.click(await screen.findByRole('button', { name: 'Edit Economy' }));
    await user.click(screen.getByRole('button', { name: 'Save revision 2' }));
    const alert = (await screen.findByText('This feature is not available in this build yet.')).closest('[role="alert"]') as HTMLElement;
    expect(alert).toHaveTextContent('INTERNAL');
    expect(screen.queryByText(/Not available yet/)).not.toBeInTheDocument();
  });
});

describe('Settings → Projects (J10)', () => {
  it('storeResponses toggle → projects.update with providerOptions.openai.storeResponses (only changed fields)', async () => {
    const user = userEvent.setup();
    const { bridge } = renderApp('/settings/projects', { scenario: 'awaiting-approval' });
    await section('Example API');
    const before = bridge.world.projects[0]?.updatedAt;
    const save = screen.getByRole('button', { name: 'Save project settings' });
    expect(save).toBeDisabled();
    const store = screen.getByRole('checkbox', { name: 'Store responses at OpenAI' });
    expect(store).toBeChecked();
    expect(screen.getByText(/Relay cannot check an unknown outcome with OpenAI/)).toBeInTheDocument();
    await user.click(store);
    await user.click(save);
    await waitFor(() => {
      expect(bridge.callsTo('relay/v1/projects.update')).toHaveLength(1);
    });
    const input = bridge.callsTo('relay/v1/projects.update')[0]?.input as { patch: Record<string, unknown>; expectedUpdatedAt: number };
    expect(input.patch).toEqual({ providerOptions: { openai: { storeResponses: false } } });
    expect(input.expectedUpdatedAt).toBe(before);
    await waitFor(() => {
      expect(bridge.world.projects[0]?.providerPolicy.providerOptions.openai.storeResponses).toBe(false);
    });
  });

  it('renames, edits exclusions with a live preview, allowed providers and the monthly allowance', async () => {
    const user = userEvent.setup();
    const { bridge } = renderApp('/settings/projects', { scenario: 'awaiting-approval' });
    await section('Example API');
    expect(await screen.findByText(/files included/)).toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: /Exclusions/ }), 'tests/**');
    expect(await screen.findByText('tests/users.test.ts', { exact: false })).toBeInTheDocument();
    await waitFor(() => {
      expect(bridge.callsTo('relay/v1/projects.previewFiles').some((c) => JSON.stringify(c.input).includes('tests/**'))).toBe(true);
    });
    const name = screen.getByRole('textbox', { name: /Project name/ });
    await user.clear(name);
    await user.type(name, 'Example API v2');
    await user.click(screen.getByRole('checkbox', { name: 'Google Gemini' }));
    const allowance = screen.getByRole('textbox', { name: /Monthly allowance/ });
    await user.clear(allowance);
    await user.type(allowance, '25.00');
    await user.click(screen.getByRole('button', { name: 'Save project settings' }));
    await waitFor(() => {
      expect(bridge.callsTo('relay/v1/projects.update')).toHaveLength(1);
    });
    expect(bridge.callsTo('relay/v1/projects.update')[0]?.input).toMatchObject({
      projectId: FAKE_PROJECT_ID,
      patch: {
        name: 'Example API v2',
        exclusions: ['tests/**'],
        allowedProviderIds: ['anthropic', 'openai', 'gemini'],
        monthlyAllowanceMicrousd: 25_000_000,
      },
    });
  });

  it('refuses to save without any allowed provider', async () => {
    const user = userEvent.setup();
    const { bridge } = renderApp('/settings/projects', { scenario: 'awaiting-approval' });
    await section('Example API');
    await user.click(screen.getByRole('checkbox', { name: 'Anthropic' }));
    await user.click(screen.getByRole('checkbox', { name: 'OpenAI' }));
    await user.click(screen.getByRole('button', { name: 'Save project settings' }));
    expect(await screen.findByText('Allow at least one provider, or no run can start.')).toBeInTheDocument();
    expect(bridge.callsTo('relay/v1/projects.update')).toHaveLength(0);
  });

  it('archives only after confirmation (projects.archive)', async () => {
    const user = userEvent.setup();
    const { bridge } = renderApp('/settings/projects', { scenario: 'completed' });
    await section('Example API');
    await user.click(screen.getByRole('button', { name: 'Archive project…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Archive “Example API”?' });
    expect(bridge.callsTo('relay/v1/projects.archive')).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Archive project' }));
    await waitFor(() => {
      expect(bridge.callsTo('relay/v1/projects.archive')[0]?.input).toEqual({ projectId: FAKE_PROJECT_ID });
    });
  });

  it('B9: archiving with an active run shows active_run with a run link and no dead Reload', async () => {
    const user = userEvent.setup();
    const { bridge } = renderApp('/settings/projects', { scenario: 'awaiting-approval' });
    await section('Example API');
    await user.click(screen.getByRole('button', { name: 'Archive project…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Archive “Example API”?' });
    await user.click(within(dialog).getByRole('button', { name: 'Archive project' }));
    expect(await within(dialog).findByText('This project has an active run')).toBeInTheDocument();
    const active = bridge.world.runs.find((r) => !['completed', 'incomplete', 'cancelled', 'failed'].includes(r.status))!;
    const link = within(within(dialog).getByRole('list', { name: 'Active runs' })).getByRole('link');
    expect(link).toHaveAttribute('href', `/p/${FAKE_PROJECT_ID}/runs/${active.id}`);
    expect(within(dialog).queryByRole('button', { name: 'Reload' })).not.toBeInTheDocument();
  });

  it('B3: a refetch keeps my edits, shows what changed on the server, and re-basing sends only my fields', async () => {
    const user = userEvent.setup();
    const { bridge, queryClient } = renderApp('/settings/projects', { scenario: 'awaiting-approval' });
    await section('Example API');
    const name = screen.getByRole('textbox', { name: /Project name/ });
    await user.clear(name);
    await user.type(name, 'Example API v2');
    const p0 = bridge.world.projects[0]!;
    bridge.world.projects = [{ ...p0, exclusions: ['fixtures/**'], updatedAt: (p0.updatedAt + 1000) as typeof p0.updatedAt }, ...bridge.world.projects.slice(1)];
    await queryClient.invalidateQueries({ queryKey: ['projects'] });
    expect(await screen.findByText('This project changed since you started editing')).toBeInTheDocument();
    expect(name).toHaveValue('Example API v2');
    const table = screen.getByRole('table', { name: 'Saved project settings compared with your edits' });
    expect(within(table).getByRole('row', { name: /Exclusions\s*\(changed on the server\)/ })).toHaveTextContent('fixtures/**');
    expect(screen.getByRole('button', { name: 'Save project settings' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Keep my changes on top of the saved settings' }));
    expect(screen.getByRole('textbox', { name: /Exclusions/ })).toHaveValue('fixtures/**');
    await user.click(screen.getByRole('button', { name: 'Save project settings' }));
    await waitFor(() => {
      expect(bridge.callsTo('relay/v1/projects.update')).toHaveLength(1);
    });
    expect(bridge.callsTo('relay/v1/projects.update')[0]?.input).toEqual({
      projectId: FAKE_PROJECT_ID,
      expectedUpdatedAt: p0.updatedAt + 1000,
      patch: { name: 'Example API v2' },
    });
    expect(bridge.world.projects[0]?.exclusions).toEqual(['fixtures/**']);
  });

  it('B3: a save CONFLICT keeps my edits (no remount) and loads the server version for comparison', async () => {
    const user = userEvent.setup();
    const { bridge } = renderApp('/settings/projects', { scenario: 'awaiting-approval' });
    await section('Example API');
    const name = screen.getByRole('textbox', { name: /Project name/ });
    await user.clear(name);
    await user.type(name, 'Mine');
    const p0 = bridge.world.projects[0]!;
    bridge.world.projects = [
      { ...p0, monthlyAllowanceMicrousd: 7_000_000 as NonNullable<typeof p0.monthlyAllowanceMicrousd>, updatedAt: (p0.updatedAt + 1000) as typeof p0.updatedAt },
      ...bridge.world.projects.slice(1),
    ];
    await user.click(screen.getByRole('button', { name: 'Save project settings' }));
    expect(await screen.findByText('This project changed since you started editing')).toBeInTheDocument();
    expect(name).toHaveValue('Mine');
    expect(screen.getByRole('row', { name: /Monthly allowance\s*\(changed on the server\)/ })).toHaveTextContent('$7.00');
  });
});

describe('Settings → Storage & data (J10)', () => {
  it('Export project → projects.export; month ledger export → ledger.export({ projectId, month })', async () => {
    const user = userEvent.setup();
    const { bridge } = renderApp('/settings/data', { scenario: 'awaiting-approval' });
    await section('Exports');
    await user.click(screen.getByRole('button', { name: 'Export project…' }));
    await waitFor(() => {
      expect(bridge.callsTo('relay/v1/projects.export')[0]?.input).toEqual({ projectId: FAKE_PROJECT_ID });
    });
    expect(await screen.findByText('Project export saved')).toBeInTheDocument();

    const month = recentMonths(Date.now())[2] ?? '';
    await user.selectOptions(screen.getByRole('combobox', { name: /Ledger month/ }), month);
    await user.click(screen.getByRole('button', { name: 'Export ledger (CSV)…' }));
    await waitFor(() => {
      expect(bridge.callsTo('relay/v1/ledger.export')[0]?.input).toEqual({ projectId: FAKE_PROJECT_ID, month });
    });
  });

  it('export diagnostics: the user reviews the included items before saving', async () => {
    const user = userEvent.setup();
    const { bridge } = renderApp('/settings/data', { scenario: 'awaiting-approval' });
    await section('Exports');
    await user.click(screen.getByRole('button', { name: 'Export diagnostics…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Export diagnostics' });
    expect(within(dialog).getByText('API keys and credentials')).toBeInTheDocument();
    expect(bridge.callsTo('relay/v1/app.exportDiagnostics')).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Choose where to save…' }));
    await waitFor(() => {
      expect(bridge.callsTo('relay/v1/app.exportDiagnostics')).toHaveLength(1);
    });
  });

  it('retention days are bounded 1–365; retention and setup allowance save through app.updateSettings', async () => {
    const user = userEvent.setup();
    const { bridge } = renderApp('/settings/data', { scenario: 'awaiting-approval' });
    await section('Retention and setup allowance');
    const days = screen.getByRole('spinbutton', { name: /Keep raw provider responses/ });
    expect(days).toHaveValue(30);
    await user.clear(days);
    await user.type(days, '400');
    await user.click(screen.getByRole('button', { name: 'Save data settings' }));
    expect(await screen.findByText('Enter a whole number of days from 1 to 365.')).toBeInTheDocument();
    await user.clear(days);
    await user.type(days, '0');
    await user.click(screen.getByRole('button', { name: 'Save data settings' }));
    expect(screen.getByText('Enter a whole number of days from 1 to 365.')).toBeInTheDocument();
    expect(bridge.callsTo('relay/v1/app.updateSettings')).toHaveLength(0);
    await user.clear(days);
    await user.type(days, '90');
    const setup = screen.getByRole('textbox', { name: /Setup allowance per month/ });
    expect(setup).toHaveValue('0.05');
    await user.clear(setup);
    await user.type(setup, '0.10');
    await user.click(screen.getByRole('button', { name: 'Save data settings' }));
    await waitFor(() => {
      expect(bridge.callsTo('relay/v1/app.updateSettings').at(-1)?.input).toEqual({
        rawResponseRetentionDays: 90,
        setupAllowanceMicrousd: 100_000,
      });
    });
    await waitFor(() => {
      expect(bridge.world.settings.rawResponseRetentionDays).toBe(90);
    });
  });

  it('create backup shows where it was saved; a not_implemented answer shows the generic error, then a retry works', async () => {
    const user = userEvent.setup();
    const { bridge } = renderApp('/settings/data', { scenario: 'awaiting-approval' });
    await section('Data folder and backup');
    expect(screen.getByText(/does not claim the full database is encrypted/)).toBeInTheDocument();
    bridge.failNext('relay/v1/app.createBackup', NOT_IMPLEMENTED('relay/v1/app.createBackup'));
    await user.click(screen.getByRole('button', { name: 'Create backup' }));
    expect(await screen.findByText('This feature is not available in this build yet.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Create backup' }));
    expect(await screen.findByText('Backup created')).toBeInTheDocument();
    const calls = bridge.callsTo('relay/v1/app.createBackup');
    expect(calls).toHaveLength(2);
    // The retry of the same intent reuses its idempotency key (02 §B0).
    expect((calls[0]?.input as { idempotencyKey: string }).idempotencyKey).toBe((calls[1]?.input as { idempotencyKey: string }).idempotencyKey);
  });

  it('purge project history needs the typed confirmation phrase', async () => {
    const user = userEvent.setup();
    const { bridge } = renderApp('/settings/data', { scenario: 'awaiting-approval' });
    await section('Purge project history');
    await user.click(screen.getByRole('button', { name: 'Purge project history…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Purge the history of “Example API”?' });
    const confirm = within(dialog).getByRole('button', { name: 'Purge project history' });
    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByRole('textbox', { name: /Type “purge” to confirm/ }), 'purg');
    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByRole('textbox', { name: /Type “purge” to confirm/ }), 'e');
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    await waitFor(() => {
      expect(bridge.callsTo('relay/v1/memory.purgeProjectHistory')[0]?.input).toEqual({
        projectId: FAKE_PROJECT_ID,
        confirmPhrase: 'purge',
      });
    });
    expect(await screen.findByText('Project history purged')).toBeInTheDocument();
    expect(screen.getByText(/stored files removed\./)).toBeInTheDocument();
    expect(screen.queryByText(/could not be removed/)).not.toBeInTheDocument();
  });

  it('purge: files that could not be removed are reported (they are retried), not hidden behind a success', async () => {
    const user = userEvent.setup();
    const { bridge } = renderApp('/settings/data', { scenario: 'awaiting-approval' });
    bridge.world.purgeFailures = 3;
    await section('Purge project history');
    await user.click(screen.getByRole('button', { name: 'Purge project history…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Purge the history of “Example API”?' });
    await user.type(within(dialog).getByRole('textbox', { name: /Type “purge” to confirm/ }), 'purge');
    await user.click(within(dialog).getByRole('button', { name: 'Purge project history' }));
    expect(await screen.findByText('Project history partly purged')).toBeInTheDocument();
    expect(screen.getByText(/3 files could not be removed; they will be retried\./)).toBeInTheDocument();
    expect(screen.queryByText('Project history purged')).not.toBeInTheDocument();
  });
});

describe('Settings → Storage & data: the project acted on (B13)', () => {
  it('without ?project= the destructive cards name the fallback project prominently; purge text includes the name', async () => {
    const user = userEvent.setup();
    renderApp('/settings/data', { scenario: 'awaiting-approval' });
    await section('Purge project history');
    expect(screen.getAllByText('Acts on project “Example API”').length).toBe(2);
    await user.click(screen.getByRole('button', { name: 'Purge project history…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Purge the history of “Example API”?' });
    expect(within(dialog).getByRole('textbox', { name: /Type “purge” to confirm purging the history of “Example API”/ })).toBeInTheDocument();
  });

  it('an explicit ?project= is used and needs no fallback note', async () => {
    renderApp(`/settings/data?project=${FAKE_PROJECT_ID}`, { scenario: 'awaiting-approval' });
    await section('Purge project history');
    expect(screen.queryByText('Acts on project “Example API”')).not.toBeInTheDocument();
  });
});
