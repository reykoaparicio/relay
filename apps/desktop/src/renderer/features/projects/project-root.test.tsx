// R2 items 3 and 7: a missing project folder (Overview, Settings → Projects) and archived projects.
import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createFakeBridge, FAKE_PROJECT_ID } from '../../api/fake-bridge';
import { sid } from '../../api/fake-scenarios/world';
import { renderApp } from '../testing/render-app';
import { verificationText } from './ProjectRootMissing';

async function missingPanel() {
  const title = await screen.findByText('Project folder not found');
  return title.closest('[class*="banner"]') as HTMLElement;
}

describe('missing project folder (E2 #7)', () => {
  it('Overview: "Project folder not found" with Locate folder… and Remove project; healthy projects show nothing', async () => {
    renderApp(`/p/${FAKE_PROJECT_ID}`, { scenario: 'project-root-missing' });
    const panel = await missingPanel();
    expect(within(panel).getByText('~/code/example-api')).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Locate folder…' })).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Remove project' })).toBeInTheDocument();
  });

  it('healthy project: no missing-folder panel', async () => {
    renderApp(`/p/${FAKE_PROJECT_ID}`, { scenario: 'awaiting-approval' });
    await screen.findByRole('heading', { level: 1, name: 'Project overview' });
    await waitFor(() => {
      expect(screen.queryByText('Project folder not found')).not.toBeInTheDocument();
    });
  });

  it('Locate folder… → an unverified folder shows matched/checked counts and mismatches, then relocates with confirm: true', async () => {
    const user = userEvent.setup();
    const { bridge } = renderApp(`/p/${FAKE_PROJECT_ID}`, { scenario: 'project-root-missing' });
    const panel = await missingPanel();
    await user.click(within(panel).getByRole('button', { name: 'Locate folder…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Use this folder anyway?' });
    expect(within(dialog).getByText(/compared 9 files it used before with this folder: none match/)).toBeInTheDocument();
    const list = within(dialog).getByRole('list', { name: 'Files that differ or are missing' });
    expect(within(list).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['src/routes/users.ts', 'src/validation/schemas.ts', 'src/errors.ts']);
    const [first] = bridge.callsTo('relay/v1/projects.relocate');
    expect(first?.input).not.toHaveProperty('confirm');
    await user.click(within(dialog).getByRole('button', { name: 'Use this folder' }));
    await waitFor(() => {
      expect(bridge.callsTo('relay/v1/projects.relocate').at(-1)?.input).toMatchObject({ projectId: FAKE_PROJECT_ID, confirm: true });
    });
    expect(await screen.findByText('Project folder updated: ~/code/my-api')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByText('Project folder not found')).not.toBeInTheDocument();
    });
  });

  it('verificationText: none / a partial match (the engine confirms unless a clear majority matches) / nothing to compare', () => {
    expect(verificationText({ checkedFiles: 9, matchedFiles: 0, mismatched: [] })).toBe('Relay compared 9 files it used before with this folder: none match.');
    expect(verificationText({ checkedFiles: 9, matchedFiles: 1, mismatched: [] })).toBe('Relay compared 9 files it used before with this folder: only 1 match.');
    expect(verificationText({ checkedFiles: 0, matchedFiles: 0, mismatched: [] })).toBe('Relay has no earlier files of this project to compare with this folder.');
  });

  it('a cancelled folder dialog changes nothing', async () => {
    const user = userEvent.setup();
    const bridge = createFakeBridge('project-root-missing');
    bridge.failNext('relay/v1/projects.pickDirectory', { code: 'NOT_FOUND', userMessage: 'The folder dialog closed.', retryable: false, nextAction: 'none', alternatives: [] });
    renderApp(`/p/${FAKE_PROJECT_ID}`, { bridge });
    const panel = await missingPanel();
    await user.click(within(panel).getByRole('button', { name: 'Locate folder…' }));
    expect(await within(panel).findByText('The folder dialog closed.')).toBeInTheDocument();
    expect(bridge.callsTo('relay/v1/projects.relocate')).toHaveLength(0);
  });

  it('Remove project archives it after a confirmation and leaves the project', async () => {
    const user = userEvent.setup();
    const { bridge, router } = renderApp(`/p/${FAKE_PROJECT_ID}`, { scenario: 'project-root-missing' });
    const panel = await missingPanel();
    await user.click(within(panel).getByRole('button', { name: 'Remove project' }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove “Example API”?' });
    expect(within(dialog).getByText(/stay on this computer/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Remove project' }));
    await waitFor(() => {
      expect(bridge.callsTo('relay/v1/projects.archive')).toHaveLength(1);
    });
    await waitFor(() => {
      expect(router.state.location.pathname).not.toBe(`/p/${FAKE_PROJECT_ID}`);
    });
  });

  it('Settings → Projects: the missing folder panel replaces the file preview', async () => {
    renderApp('/settings/projects', { scenario: 'project-root-missing' });
    await screen.findByRole('heading', { level: 2, name: 'Example API' });
    expect(await screen.findByText('Project folder not found')).toBeInTheDocument();
    expect(await screen.findByText('No preview: the project folder was not found.')).toBeInTheDocument();
  });
});

describe('archived projects (E2 #18)', () => {
  it('Settings → Projects lists archived projects in a collapsed section; Restore calls projects.unarchive', async () => {
    const user = userEvent.setup();
    const { bridge } = renderApp('/settings/projects', { scenario: 'unreadable-file' });
    const summary = await screen.findByText('Archived projects (1)');
    const details = summary.closest('details') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    await user.click(summary);
    const list = within(details).getByRole('list', { name: 'Archived projects' });
    expect(within(list).getByText('Old billing service')).toBeInTheDocument();
    await user.click(within(list).getByRole('button', { name: 'Restore Old billing service' }));
    await waitFor(() => {
      expect(bridge.callsTo('relay/v1/projects.unarchive').map((c) => c.input)).toEqual([{ projectId: sid('project', 2) }]);
    });
    expect(await screen.findByText('Restored “Old billing service”')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByText(/Archived projects \(/)).not.toBeInTheDocument();
    });
  });

  it('no archived projects: no section', async () => {
    renderApp('/settings/projects', { scenario: 'awaiting-approval' });
    await screen.findByRole('heading', { level: 2, name: 'Example API' });
    await waitFor(() => {
      expect(screen.queryByText(/Archived projects/)).not.toBeInTheDocument();
    });
  });
});

describe('missing project folder on New run (E2 #7)', () => {
  it('New run shows the panel instead of the form; after locating the folder the form comes back', async () => {
    const user = userEvent.setup();
    const bridge = createFakeBridge('project-root-missing');
    bridge.world.relocateUnverified = false;
    renderApp(`/p/${FAKE_PROJECT_ID}/runs/new`, { bridge });
    const panel = await missingPanel();
    expect(screen.queryByRole('form', { name: 'New run' })).not.toBeInTheDocument();
    await user.click(within(panel).getByRole('button', { name: 'Locate folder…' }));
    expect(await screen.findByRole('form', { name: 'New run' })).toBeInTheDocument();
    expect(bridge.callsTo('relay/v1/projects.relocate').map((c) => c.input)).toEqual([
      expect.objectContaining({ projectId: FAKE_PROJECT_ID }),
    ]);
  });
});
