/* eslint-disable @typescript-eslint/unbound-method -- asserting on vi.fn() members */
import { describe, expect, it, vi } from 'vitest';
import { epochMs, errors, err, ok } from '@relay/contracts';
import type { ProviderStatus, SelectionId } from '@relay/contracts';
import type { CredentialVault } from '../../credentials.js';
import type { DialogService } from '../../dialogs.js';
import type { SampleService } from '../../samples.js';
import { createCompositeHandlers } from './composite.js';
import type { CompositeDeps } from './composite.js';

vi.mock('electron', () => ({}));

const SEL = 'sel_01J0000000000000000000000A' as SelectionId;
const PRJ = 'prj_01J0000000000000000000000A';
const RUN = 'run_01J0000000000000000000000A';
const HOME = '/Users/alice';

function status(over: Partial<ProviderStatus> = {}): ProviderStatus {
  return { providerId: 'anthropic', displayName: 'Anthropic', connected: false, storage: 'none', redactedLabel: null, lastTest: null, ...over };
}

function setup(runnerReplies: Record<string, unknown> = {}) {
  const request = vi.fn((...args: [channel: string, input: unknown]) => {
    const reply = runnerReplies[args[0]];
    return Promise.resolve(reply ?? { ok: true, data: {} });
  });
  let selected = true;
  const dialogs: DialogService = {
    pickDirectory: vi.fn(),
    resolveSelection: vi.fn(() => (selected ? ok({ realpath: `${HOME}/code/app`, displayPath: '~/code/app' }) : err(errors.notFound('selection')))),
    consumeSelection: vi.fn(() => {
      selected = false;
    }),
    pickDiffFile: vi.fn(() => Promise.resolve(ok({ text: 'diff', fileName: 'a.diff' }))),
    pickExportDir: vi.fn(() => Promise.resolve(ok(`${HOME}/exports`))),
    pickSaveFile: vi.fn((name: string) => Promise.resolve(ok(`${HOME}/exports/${name}`))),
  };
  const vault = {
    status: vi.fn(() => Promise.resolve({ available: true, backend: 'keychain' })),
    save: vi.fn(() => Promise.resolve(ok({ storageMode: 'os_protected' as const, vaultFile: 'secrets/crd_01J0000000000000000000000A.bin', redactedLabel: 'sk-…abcd' }))),
    get: vi.fn(),
    remove: vi.fn(() => Promise.resolve()),
    hasSession: vi.fn((p: string): boolean => p === ''),
    sessionLabel: vi.fn((p: string): string | null => (p === '' ? '' : null)),
    deleteVaultFile: vi.fn(() => Promise.resolve()),
    discard: vi.fn(() => Promise.resolve()),
  } satisfies CredentialVault;
  const samples: SampleService = { copySample: vi.fn() };
  const deps: CompositeDeps = {
    runner: { request } as unknown as CompositeDeps['runner'],
    dialogs, vault, samples,
    supervisorState: () => ({ state: 'ready', restarts: 0, pid: 42, lastHeartbeatAt: epochMs(5) }),
    appInfo: () => ({ version: '0', buildId: 'dev', electron: '44', node: '24', platform: 'darwin', userDataDisplayPath: '~', isPackaged: false, providerMode: 'fake', fakeScenario: null }),
    homeDir: HOME,
    clock: { now: () => epochMs(1_700_000_000_000) },
    writeTextFile: vi.fn(() => Promise.resolve()),
    notifyProvidersChanged: vi.fn(),
  };
  return { h: createCompositeHandlers(deps), request, dialogs, vault, setSelected: (v: boolean) => (selected = v) };
}

describe('composite handlers (H4)', () => {
  it('projects.create → projects.createFromRoot with the realpath, then consumes the token (second use → NOT_FOUND)', async () => {
    const { h, request } = setup({ 'relay/v1/projects.createFromRoot': { ok: true, data: { id: PRJ } } });
    const input = { idempotencyKey: 'key-0000000001', selectionId: SEL, name: 'App', allowedProviderIds: ['anthropic' as const] };

    const first = await h['relay/v1/projects.create'](input);
    const second = await h['relay/v1/projects.create'](input);

    expect(first.ok).toBe(true);
    expect(request).toHaveBeenCalledWith('relay/v1/projects.createFromRoot', expect.objectContaining({
      rootRealpath: `${HOME}/code/app`, rootDisplayPath: '~/code/app', isDemo: false, exclusions: [], monthlyAllowanceMicrousd: null,
    }));
    expect(!second.ok && second.error.code).toBe('NOT_FOUND');
  });

  it('a failed create keeps the token', async () => {
    const { h, dialogs } = setup({ 'relay/v1/projects.createFromRoot': { ok: false, error: errors.conflict() } });

    await h['relay/v1/projects.create']({ idempotencyKey: 'key-0000000001', selectionId: SEL, name: 'App', allowedProviderIds: [] });

    expect(dialogs.consumeSelection).not.toHaveBeenCalled();
  });

  it('projects.previewFiles resolves the selection without consuming it', async () => {
    const { h, request, dialogs } = setup();

    await h['relay/v1/projects.previewFiles']({ selectionId: SEL });

    expect(request).toHaveBeenCalledWith('relay/v1/projects.previewRoot', { rootRealpath: `${HOME}/code/app`, extraExclusions: [] });
    expect(dialogs.consumeSelection).not.toHaveBeenCalled();
  });

  it('exports call the matching internal *.exportTo with a realpath destination', async () => {
    const { h, request } = setup({
      'relay/v1/projects.get': { ok: true, data: { name: 'My App!' } },
      'relay/v1/projects.exportTo': { ok: true, data: { writtenRealpath: `${HOME}/exports/relay-project-my-app.json` } },
      'relay/v1/ledger.exportTo': { ok: true, data: { writtenRealpath: `${HOME}/exports/l.csv` } },
      'relay/v1/artifacts.exportTo': { ok: true, data: { writtenRealpaths: [`${HOME}/exports/report.md`] } },
    });

    const p = await h['relay/v1/projects.export']({ projectId: PRJ } as never);
    const l = await h['relay/v1/ledger.export']({ runId: RUN } as never);
    const a = await h['relay/v1/artifacts.export']({ runId: RUN, what: 'report' } as never);

    expect(request).toHaveBeenCalledWith('relay/v1/projects.exportTo', { projectId: PRJ, destinationRealpath: `${HOME}/exports/relay-project-my-app.json` });
    expect(request).toHaveBeenCalledWith('relay/v1/ledger.exportTo', { runId: RUN, destinationRealpath: `${HOME}/exports/relay-ledger-${RUN}.csv` });
    expect(request).toHaveBeenCalledWith('relay/v1/artifacts.exportTo', { runId: RUN, what: 'report', destinationRealpath: `${HOME}/exports` });
    expect(p).toEqual({ ok: true, data: { exported: true, displayPath: '~/exports/relay-project-my-app.json' } });
    expect(l.ok).toBe(true);
    expect(a).toEqual({ ok: true, data: { exported: true, displayPaths: ['~/exports/report.md'] } });
  });

  it('a cancelled export dialog returns exported: false without calling the runner export', async () => {
    const { h, request, dialogs } = setup();
    vi.mocked(dialogs.pickExportDir).mockResolvedValueOnce(ok(null));
    vi.mocked(dialogs.pickSaveFile).mockResolvedValueOnce(ok(null));

    const a = await h['relay/v1/artifacts.export']({ runId: RUN, what: 'both' } as never);
    const l = await h['relay/v1/ledger.export']({ runId: RUN } as never);

    expect(a).toEqual({ ok: true, data: { exported: false, displayPaths: [] } });
    expect(l).toEqual({ ok: true, data: { exported: false } });
    expect(request).not.toHaveBeenCalledWith('relay/v1/artifacts.exportTo', expect.anything());
  });

  it('artifacts.importDiff → artifacts.importDiffText', async () => {
    const { h, request } = setup();

    await h['relay/v1/artifacts.importDiff']({ projectId: PRJ } as never);

    expect(request).toHaveBeenCalledWith('relay/v1/artifacts.importDiffText', { projectId: PRJ, text: 'diff', fileName: 'a.diff' });
  });

  it('providers.connect records the credential ref; a runner failure discards what the vault just wrote', async () => {
    const good = setup({ 'relay/v1/providers.list': { ok: true, data: [status({ connected: true, storage: 'os_protected' })] }, 'relay/v1/providers.listCredentialRefs': { ok: true, data: [] } });
    const bad = setup({ 'relay/v1/providers.recordCredentialRef': { ok: false, error: errors.validationFailed([]) }, 'relay/v1/providers.listCredentialRefs': { ok: true, data: [] } });
    const input = { providerId: 'anthropic' as const, apiKey: 'sk-ant-api03-xxxxxxxxxxxxxxxxxxxxxx', storage: 'os_protected' as const };

    const r = await good.h['relay/v1/providers.connect'](input);
    const f = await bad.h['relay/v1/providers.connect'](input);

    expect(good.request).toHaveBeenCalledWith('relay/v1/providers.recordCredentialRef', {
      providerId: 'anthropic', storageMode: 'os_protected', vaultFile: 'secrets/crd_01J0000000000000000000000A.bin', redactedLabel: 'sk-…abcd',
    });
    expect(r.ok && r.data.connected).toBe(true);
    expect(f.ok).toBe(false);
    expect(bad.vault.discard).toHaveBeenCalled();
    expect(JSON.stringify(good.request.mock.calls)).not.toContain('sk-ant-api03');
  });

  it('providers.disconnect removes the vault entry and calls deleteCredentialRef', async () => {
    const { h, request, vault } = setup({ 'relay/v1/providers.list': { ok: true, data: [status()] } });

    await h['relay/v1/providers.disconnect']({ providerId: 'anthropic' });

    expect(vault.remove).toHaveBeenCalledWith('anthropic');
    expect(request).toHaveBeenCalledWith('relay/v1/providers.deleteCredentialRef', { providerId: 'anthropic' });
  });

  it('providers.list overlays session keys and hides stale session refs', async () => {
    const { h, vault } = setup({ 'relay/v1/providers.list': { ok: true, data: [status({ connected: true, storage: 'session', redactedLabel: 'sk-…x' }), status({ providerId: 'openai' })] } });
    vault.hasSession.mockImplementation((p) => p === 'openai');
    vault.sessionLabel.mockImplementation(() => 'sk-…o');

    const r = await h['relay/v1/providers.list']({});

    expect(r.ok && r.data.map((s) => [s.providerId, s.connected, s.storage])).toEqual([['anthropic', false, 'none'], ['openai', true, 'session']]);
  });

  it('providers.test answers AUTH_REQUIRED without a stored key', async () => {
    const { h, request } = setup({ 'relay/v1/providers.listCredentialRefs': { ok: true, data: [] } });

    const r = await h['relay/v1/providers.test']({ providerId: 'anthropic' });

    expect(!r.ok && r.error.code).toBe('AUTH_REQUIRED');
    expect(request).not.toHaveBeenCalledWith('relay/v1/providers.test', expect.anything());
  });

  it('app.getDiagnostics overlays supervisor state and secure storage, degrading when the runner is unavailable', async () => {
    const { h } = setup({ 'relay/v1/app.getDiagnostics': { ok: false, error: errors.runnerUnavailable() } });

    const r = await h['relay/v1/app.getDiagnostics']({});

    expect(r.ok && r.data.runner).toEqual({ state: 'ready', pid: 42, lastHeartbeatAt: 5, restarts: 0 });
    expect(r.ok && r.data.secureStorage).toEqual({ available: true, backend: 'keychain' });
  });
});
