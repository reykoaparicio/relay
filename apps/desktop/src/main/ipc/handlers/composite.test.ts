/* eslint-disable @typescript-eslint/unbound-method -- asserting on vi.fn() members */
import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UNIVERSAL_ERROR_CODES, createIdGen, epochMs, errors, err, getOperation, ok } from '@relay/contracts';
import type { IpcEnvelope, ProviderId, ProviderStatus, SelectionId } from '@relay/contracts';
import type { CompositeChannel, HandlerTable } from '../types.js';
import { createCredentialVault } from '../../credentials.js';
import type { CredentialVault } from '../../credentials.js';
import type { DialogService } from '../../dialogs.js';
import type { SampleService } from '../../samples.js';
import { makeTempDir, removeTempDir } from '../../testing/temp-dirs.js';
import { createCompositeHandlers, createKeyedMutex } from './composite.js';
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
    commit: vi.fn(),
    pruneUnreferenced: vi.fn(() => Promise.resolve()),
  } satisfies CredentialVault;
  const samples: SampleService = { copySample: vi.fn() };
  const deps: CompositeDeps = {
    runner: { request } as unknown as CompositeDeps['runner'],
    dialogs, vault, samples,
    supervisorState: () => ({ state: 'ready', restarts: 0, pid: 42, lastHeartbeatAt: epochMs(5), lastFatal: null, activeRunId: null }),
    appInfo: () => ({ version: '0', buildId: 'dev', electron: '44', node: '24', platform: 'darwin', userDataDisplayPath: '~', isPackaged: false, providerMode: 'fake', fakeScenario: null }),
    homeDir: HOME,
    clock: { now: () => epochMs(1_700_000_000_000) },
    writeNewTextFile: vi.fn((p: string) => Promise.resolve(p)),
    dbFile: `${HOME}/Library/Application Support/Relay/relay.sqlite`,
    fileSize: vi.fn((p: string) => Promise.resolve(p.endsWith('-wal') ? 4096 : p.endsWith('.sqlite') ? 1_000_000 : null)),
    loggingDegraded: () => false,
    lastShutdown: () => null,
    notifyProvidersChanged: vi.fn(),
  };
  return { h: withErrorConformance(createCompositeHandlers(deps)), deps, request, dialogs, vault, setSelected: (v: boolean) => (selected = v) };
}

/**
 * 02 §B5: every composite result in this suite must use a code its operation declares (`op.errors ∪
 * UNIVERSAL_ERROR_CODES`) — the router's strict check, applied to direct handler calls.
 */
function withErrorConformance(table: HandlerTable<CompositeChannel>): HandlerTable<CompositeChannel> {
  const wrapped: Record<string, (input: never) => Promise<IpcEnvelope<unknown>>> = {};
  for (const [channel, handler] of Object.entries(table) as [string, (input: never) => Promise<IpcEnvelope<unknown>>][]) {
    wrapped[channel] = async (input) => {
      const res = await handler(input);
      const declared: readonly string[] = [...(getOperation(channel)?.errors ?? []), ...UNIVERSAL_ERROR_CODES];
      if (!res.ok && !declared.includes(res.error.code)) throw new Error(`error-code conformance: ${channel} returned undeclared ${res.error.code}`);
      return res;
    };
  }
  return wrapped as unknown as HandlerTable<CompositeChannel>;
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

  it('projects.relocate resolves the selection, calls relocateRoot, keeps the token on an unverified-root CONFLICT, consumes it on success', async () => {
    const verification = { checkedFiles: 3, matchedFiles: 1, mismatched: ['a.ts', 'b.ts'] };
    const conflict = { ok: false, error: errors.conflict({ reason: 'root_unverified', verification }) };
    const { h, request, dialogs } = setup({ 'relay/v1/projects.relocateRoot': conflict });

    const first = await h['relay/v1/projects.relocate']({ projectId: PRJ, selectionId: SEL } as never);

    expect(request).toHaveBeenCalledExactlyOnceWith('relay/v1/projects.relocateRoot', { projectId: PRJ, rootRealpath: `${HOME}/code/app`, rootDisplayPath: '~/code/app' });
    expect(!first.ok && first.error.code).toBe('CONFLICT');
    expect(dialogs.consumeSelection).not.toHaveBeenCalled();

    request.mockResolvedValueOnce({ ok: true, data: { project: { id: PRJ }, verification } });
    const second = await h['relay/v1/projects.relocate']({ projectId: PRJ, selectionId: SEL, confirm: true } as never);

    expect(request).toHaveBeenLastCalledWith('relay/v1/projects.relocateRoot', expect.objectContaining({ confirm: true }));
    expect(second.ok).toBe(true);
    expect(dialogs.consumeSelection).toHaveBeenCalledExactlyOnceWith(SEL);
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

    expect(r.ok && r.data.runner).toEqual({ state: 'ready', pid: 42, lastHeartbeatAt: 5, restarts: 0, lastFatal: null });
    expect(r.ok && r.data.secureStorage).toEqual({ available: true, backend: 'keychain' });
  });
});

describe('composite handlers: diagnostics export, sample project, preview by project (H4)', () => {
  const FAKE_KEY = 'sk-ant-api03-SEEDEDFAKEKEY0123456789abcdef';

  it('app.exportDiagnostics writes a redacted file: a key seeded in a log line, an error message, and an apiKey field never reach it', async () => {
    const { h, deps } = setup({
      'relay/v1/app.getDiagnostics': {
        ok: true,
        data: {
          db: { schemaVersion: 7, migrationsPending: 0, sizeBytes: 1 }, unresolvedAttempts: 0, catalog: { version: 'c1', models: 3 }, prompts: { loaded: 4 },
          lastLogLine: `{"event":"provider.call","outcome":"error","err":"401 invalid x-api-key ${FAKE_KEY}"}`,
        },
      },
      'relay/v1/runs.get': { ok: true, data: { id: RUN, statusDetail: { userMessage: `Auth failed for Bearer ${FAKE_KEY}` }, apiKey: FAKE_KEY } },
    });
    const r = await h['relay/v1/app.exportDiagnostics']({ includeRunIds: [RUN] } as never);
    const written = vi.mocked(deps.writeNewTextFile).mock.calls.map((c) => c[1]);

    expect(r).toEqual({ ok: true, data: { exported: true, displayPath: '~/exports/relay-diagnostics-2023-11-14.json' } });
    expect(written).toHaveLength(1);
    const text = written[0] ?? '';
    expect(text).not.toContain(FAKE_KEY);
    expect(text).not.toContain('SEEDEDFAKEKEY');
    expect(text).toContain('[REDACTED:sk-…cdef]');
    const parsed = JSON.parse(text) as { runs: Record<string, unknown>[]; diagnostics: { runner: unknown } };
    expect(parsed.runs[0]).not.toHaveProperty('apiKey');
    expect(parsed.diagnostics.runner).toEqual({ state: 'ready', pid: 42, lastHeartbeatAt: 5, restarts: 0, lastFatal: null });
  });

  it('app.exportDiagnostics: a cancelled save dialog writes nothing', async () => {
    const { h, dialogs } = setup({ 'relay/v1/app.getDiagnostics': { ok: false, error: errors.runnerUnavailable() } });
    vi.mocked(dialogs.pickSaveFile).mockResolvedValueOnce(ok(null));

    const r = await h['relay/v1/app.exportDiagnostics']({});

    expect(r).toEqual({ ok: true, data: { exported: false } });
  });

  it('projects.createSample copies the sample, then creates it with isDemo: true', async () => {
    const createInput = {
      rootRealpath: `${HOME}/Documents/Relay Samples/sample-api-1`, rootDisplayPath: '~/Documents/Relay Samples/sample-api-1', name: 'Sample API',
      exclusions: [], allowedProviderIds: ['anthropic' as const], monthlyAllowanceMicrousd: 20_000_000,
    };
    const request = vi.fn((c: string, input: unknown) =>
      Promise.resolve(c === 'relay/v1/projects.list' ? { ok: true, data: [] } : { ok: true, data: { id: PRJ, ...(input as object) } }));
    const copySample = vi.fn(() => Promise.resolve(ok({ realpath: createInput.rootRealpath, createInput })));
    const h = createCompositeHandlers({
      runner: { request } as unknown as CompositeDeps['runner'],
      dialogs: {} as DialogService, vault: {} as CredentialVault, samples: { copySample },
      supervisorState: () => ({ state: 'ready', restarts: 0, lastFatal: null, activeRunId: null }),
      appInfo: () => ({ version: '0', buildId: 'dev', electron: '44', node: '24', platform: 'darwin', userDataDisplayPath: '~', isPackaged: false, providerMode: 'fake', fakeScenario: null }),
      homeDir: HOME, clock: { now: () => epochMs(0) }, writeNewTextFile: (p) => Promise.resolve(p), dbFile: '/ud/relay.sqlite', fileSize: () => Promise.resolve(null), loggingDegraded: () => false, lastShutdown: () => null, notifyProvidersChanged: () => undefined,
    });

    const r = await h['relay/v1/projects.createSample']({ idempotencyKey: 'key-0000000001' });

    expect(copySample).toHaveBeenCalledExactlyOnceWith('key-0000000001');
    expect(request).toHaveBeenCalledWith('relay/v1/projects.list', {});
    expect(request).toHaveBeenLastCalledWith('relay/v1/projects.createFromRoot', { idempotencyKey: 'key-0000000001', ...createInput, isDemo: true });
    expect(request).toHaveBeenCalledTimes(2);
    expect(r.ok && (r.data as { isDemo?: boolean }).isDemo).toBe(true);
  });

  it('projects.createSample: a failed copy never reaches the runner', async () => {
    const request = vi.fn((c: string) => Promise.resolve(c === 'relay/v1/projects.list' ? { ok: true, data: [] } : { ok: false, error: errors.conflict() }));
    const h = createCompositeHandlers({
      runner: { request } as unknown as CompositeDeps['runner'],
      dialogs: {} as DialogService, vault: {} as CredentialVault,
      samples: { copySample: () => Promise.resolve(err(errors.artifactWriteFailed())) },
      supervisorState: () => ({ state: 'ready', restarts: 0, lastFatal: null, activeRunId: null }),
      appInfo: () => ({ version: '0', buildId: 'dev', electron: '44', node: '24', platform: 'darwin', userDataDisplayPath: '~', isPackaged: false, providerMode: 'fake', fakeScenario: null }),
      homeDir: HOME, clock: { now: () => epochMs(0) }, writeNewTextFile: (p) => Promise.resolve(p), dbFile: '/ud/relay.sqlite', fileSize: () => Promise.resolve(null), loggingDegraded: () => false, lastShutdown: () => null, notifyProvidersChanged: () => undefined,
    });

    const r = await h['relay/v1/projects.createSample']({ idempotencyKey: 'key-0000000001' });

    expect(!r.ok && r.error.code).toBe('ARTIFACT_WRITE_FAILED');
    expect(request).not.toHaveBeenCalledWith('relay/v1/projects.createFromRoot', expect.anything());
  });

  it('projects.createSample returns the existing (non-archived) sample instead of copying it again — also for two quick clicks', async () => {
    const sample = { id: PRJ, name: 'Sample API', isDemo: true, archivedAt: null };
    const projects: unknown[] = [{ id: 'prj_01J0000000000000000000000B', isDemo: true, archivedAt: 5 }, { id: 'prj_01J0000000000000000000000C', isDemo: false, archivedAt: null }];
    const request = vi.fn((c: string) => {
      if (c === 'relay/v1/projects.list') return Promise.resolve({ ok: true, data: [...projects] });
      projects.push(sample); // createFromRoot registers the sample
      return Promise.resolve({ ok: true, data: sample });
    });
    const copySample = vi.fn(() => Promise.resolve(ok({ realpath: '/s', createInput: { rootRealpath: '/s', rootDisplayPath: '/s', name: 'Sample API', exclusions: [], allowedProviderIds: [], monthlyAllowanceMicrousd: null } })));
    const { deps } = setup();
    const h = createCompositeHandlers({ ...deps, runner: { request } as unknown as CompositeDeps['runner'], samples: { copySample } });

    const [a, b] = await Promise.all([
      h['relay/v1/projects.createSample']({ idempotencyKey: 'key-0000000001' }),
      h['relay/v1/projects.createSample']({ idempotencyKey: 'key-0000000002' }),
    ]);
    const c = await h['relay/v1/projects.createSample']({ idempotencyKey: 'key-0000000003' });

    expect(copySample).toHaveBeenCalledOnce(); // the archived demo and the non-demo project were not reused
    expect([a, b, c].map((r) => r.ok && r.data.id)).toEqual([PRJ, PRJ, PRJ]);
  });

  it('app.getDiagnostics with the runner down reports lastFatal, the DB display path and the on-disk size (incl. -wal)', async () => {
    const { deps } = setup({ 'relay/v1/app.getDiagnostics': { ok: false, error: errors.runnerUnavailable() } });
    const lastFatal = { code: 'DATABASE_UNAVAILABLE' as const, reason: 'db_corrupt', message: 'database disk image is malformed', at: epochMs(9) };
    const h = createCompositeHandlers({
      ...deps, loggingDegraded: () => true, lastShutdown: () => ({ clean: false, at: epochMs(3), runActive: false }),
      supervisorState: () => ({ state: 'unavailable', restarts: 0, lastFatal, activeRunId: null }),
    });

    const r = await h['relay/v1/app.getDiagnostics']({});

    expect(r.ok && r.data.runner.lastFatal).toEqual(lastFatal);
    expect(r.ok && r.data.db).toEqual({ schemaVersion: 0, migrationsPending: 0, sizeBytes: 1_004_096, displayPath: '~/Library/Application Support/Relay/relay.sqlite' });
    expect(r.ok && r.data.loggingDegraded).toBe(true);
    expect(r.ok && r.data.lastShutdown).toEqual({ clean: false, at: 3, runActive: false });
    expect(getOperation('relay/v1/app.getDiagnostics')?.output.safeParse(r.ok && r.data).success).toBe(true);
  });

  it('app.getDiagnostics with a live runner replaces its DB size with the on-disk size and adds the display path', async () => {
    const { h } = setup({
      'relay/v1/app.getDiagnostics': {
        ok: true, data: { db: { schemaVersion: 7, migrationsPending: 0, sizeBytes: 1 }, unresolvedAttempts: 0, catalog: { version: 'c1', models: 3 }, prompts: { loaded: 4 } },
      },
    });

    const r = await h['relay/v1/app.getDiagnostics']({});

    expect(r.ok && r.data.db).toEqual({ schemaVersion: 7, migrationsPending: 0, sizeBytes: 1_004_096, displayPath: '~/Library/Application Support/Relay/relay.sqlite' });
  });

  it('app.exportDiagnostics reports the path actually written (a taken name got a suffix)', async () => {
    const { deps } = setup({ 'relay/v1/app.getDiagnostics': { ok: false, error: errors.runnerUnavailable() } });
    const h = createCompositeHandlers({ ...deps, writeNewTextFile: (p) => Promise.resolve(p.replace(/\.json$/, ' (2).json')) });

    const r = await h['relay/v1/app.exportDiagnostics']({});

    expect(r).toEqual({ ok: true, data: { exported: true, displayPath: '~/exports/relay-diagnostics-2023-11-14 (2).json' } });
  });

  it('artifacts.export passes a partial export through: written parts as display paths, failed parts as-is', async () => {
    const { h } = setup({
      'relay/v1/artifacts.exportTo': {
        ok: true,
        data: { writtenRealpaths: [`${HOME}/exports/report.md`], written: [{ what: 'report', realpath: `${HOME}/exports/report.md` }], failed: [{ what: 'patch', code: 'ARTIFACT_WRITE_FAILED' }] },
      },
    });

    const r = await h['relay/v1/artifacts.export']({ runId: RUN, what: 'both' } as never);

    expect(r).toEqual({
      ok: true,
      data: { exported: true, displayPaths: ['~/exports/report.md'], written: [{ what: 'report', displayPath: '~/exports/report.md' }], failed: [{ what: 'patch', code: 'ARTIFACT_WRITE_FAILED' }] },
    });
  });

  it('projects.previewFiles {projectId} previews the registered project without touching selections', async () => {
    const { h, request, dialogs } = setup({ 'relay/v1/projects.previewRoot': { ok: true, data: { included: [] } } });

    const r = await h['relay/v1/projects.previewFiles']({ projectId: PRJ, extraExclusions: ['dist/**'] } as never);

    expect(request).toHaveBeenCalledExactlyOnceWith('relay/v1/projects.previewRoot', { projectId: PRJ, extraExclusions: ['dist/**'] });
    expect(dialogs.resolveSelection).not.toHaveBeenCalled();
    expect(r).toEqual({ ok: true, data: { included: [] } });
  });
});

describe('providers.connect with a real vault (F5 regressions)', () => {
  let dir = '';
  const ids = createIdGen({ now: () => epochMs(1_700_000_000_000) }, (n) => new Uint8Array(n).map(() => Math.floor(Math.random() * 256)));
  const enc = (x: string) => Buffer.from(`ENC:${x}`);
  const dec = (b: Buffer) => b.toString().slice(4);

  beforeEach(async () => {
    dir = await makeTempDir('connect');
    await mkdir(join(dir, 'secrets'));
  });
  afterEach(async () => {
    await removeTempDir(dir); // ownership-guarded: only a dir makeTempDir created
  });

  /** A runner double holding credential refs; every call yields a few ticks so concurrent handlers can interleave. */
  function world(opts: { failRecord?: boolean } = {}) {
    const refs = new Map<ProviderId, { vaultFile: string | null; storageMode: string }>();
    const yieldTicks = async () => {
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
    };
    const request = vi.fn(async (channel: string, input: unknown) => {
      await yieldTicks();
      const i = input as { providerId: ProviderId; vaultFile: string | null; storageMode: string };
      switch (channel) {
        case 'relay/v1/providers.listCredentialRefs':
          return { ok: true, data: [...refs].map(([providerId, r]) => ({ providerId, ...r })) };
        case 'relay/v1/providers.recordCredentialRef':
          if (opts.failRecord === true) return { ok: false, error: errors.validationFailed([]) };
          refs.set(i.providerId, { vaultFile: i.vaultFile, storageMode: i.storageMode });
          return { ok: true, data: {} };
        case 'relay/v1/providers.deleteCredentialRef':
          refs.delete(i.providerId);
          return { ok: true, data: {} };
        case 'relay/v1/providers.list':
          return { ok: true, data: [status()] };
        default:
          return { ok: true, data: {} };
      }
    });
    const runner = { request } as unknown as CompositeDeps['runner'];
    const vault = createCredentialVault({
      safeStorage: { isEncryptionAvailable: () => true, encryptString: enc, decryptString: dec },
      userDataDir: dir, platform: 'darwin', ids,
      lookupVaultFile: (p) => Promise.resolve(refs.get(p)?.vaultFile ?? null),
    });
    const h = createCompositeHandlers({
      runner, vault,
      dialogs: {} as DialogService, samples: {} as SampleService,
      supervisorState: () => ({ state: 'ready', restarts: 0, lastFatal: null, activeRunId: null }),
      appInfo: () => ({ version: '0', buildId: 'dev', electron: '44', node: '24', platform: 'darwin', userDataDisplayPath: '~', isPackaged: false, providerMode: 'fake', fakeScenario: null }),
      homeDir: HOME, clock: { now: () => epochMs(0) }, writeNewTextFile: (p) => Promise.resolve(p), dbFile: '/ud/relay.sqlite', fileSize: () => Promise.resolve(null), loggingDegraded: () => false, lastShutdown: () => null, notifyProvidersChanged: () => undefined,
    });
    return { h, vault, refs };
  }

  it('two concurrent connects for one provider leave exactly one vault file — the recorded one', async () => {
    const { h, refs } = world();
    const input = (k: string) => ({ providerId: 'anthropic' as const, apiKey: `sk-ant-api03-${k}xxxxxxxxxxxxxxxxxxxx`, storage: 'os_protected' as const });

    const [a, b] = await Promise.all([h['relay/v1/providers.connect'](input('a')), h['relay/v1/providers.connect'](input('b'))]);

    expect(a.ok && b.ok).toBe(true);
    const files = await readdir(join(dir, 'secrets'));
    expect(files).toHaveLength(1);
    expect(`secrets/${files[0] ?? ''}`).toBe(refs.get('anthropic')?.vaultFile);
  });

  it('prunes orphaned vault files (e.g., from a crash mid-connect) after a successful connect', async () => {
    const { h, vault } = world();
    const orphan = await vault.save('openai', 'sk-orphan-xxxxxxxxxxxxxxxxxxxx', 'os_protected'); // never recorded
    if (!orphan.ok) throw new Error('save failed');
    vault.commit('openai', orphan.value); // no longer in flight: a leftover nobody references

    await h['relay/v1/providers.connect']({ providerId: 'anthropic', apiKey: 'sk-ant-api03-cxxxxxxxxxxxxxxxxxxxx', storage: 'os_protected' });

    expect(await readdir(join(dir, 'secrets'))).toHaveLength(1);
  });

  it('a failed recordCredentialRef restores the session key the save removed, and leaves no file', async () => {
    const { h, vault } = world({ failRecord: true });
    await vault.save('anthropic', 'sk-session-old-xxxxxxxxxxxxxxxxxxxx', 'session');

    const r = await h['relay/v1/providers.connect']({ providerId: 'anthropic', apiKey: 'sk-ant-api03-newxxxxxxxxxxxxxxxxxx', storage: 'os_protected' });

    expect(r.ok).toBe(false);
    expect(vault.hasSession('anthropic')).toBe(true);
    expect(await vault.get('anthropic')).toEqual({ ok: true, value: 'sk-session-old-xxxxxxxxxxxxxxxxxxxx' });
    expect(await readdir(join(dir, 'secrets'))).toEqual([]);
  });

  it('a failed record of a session key restores the previous session key', async () => {
    const { h, vault } = world({ failRecord: true });
    await vault.save('anthropic', 'sk-session-old-xxxxxxxxxxxxxxxxxxxx', 'session');

    await h['relay/v1/providers.connect']({ providerId: 'anthropic', apiKey: 'sk-session-new-xxxxxxxxxxxxxxxxxx', storage: 'session' });

    expect(await vault.get('anthropic')).toEqual({ ok: true, value: 'sk-session-old-xxxxxxxxxxxxxxxxxxxx' });
  });
});

describe('createKeyedMutex', () => {
  it('serializes per key (even after a rejection) and runs different keys concurrently', async () => {
    const m = createKeyedMutex();
    const log: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));

    const a1 = m.run('a', async () => {
      log.push('a1:start');
      await gate;
      log.push('a1:end');
      throw new Error('a1');
    });
    const a2 = m.run('a', () => (log.push('a2'), Promise.resolve(2)));
    const b1 = m.run('b', () => (log.push('b1'), Promise.resolve(1)));
    await b1;
    expect(log).toEqual(['a1:start', 'b1']);
    release();

    await expect(a1).rejects.toThrow('a1');
    await expect(a2).resolves.toBe(2);
    expect(log).toEqual(['a1:start', 'b1', 'a1:end', 'a2']);
  });
});
