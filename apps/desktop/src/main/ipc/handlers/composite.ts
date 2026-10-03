// 08 H4 composite handlers (route `main+runner`): main does the dialog / realpath / vault half, then calls the runner
// through `supervisor.request` — INTERNAL_RUNNER_OPS or the same channel for FORWARDED_COMPOSITE_CHANNELS.
import { appError, errors, redactDeep, toDisplayPath } from '@relay/contracts';
import type { AppError, AppInfo, Clock, CredentialRef, Diagnostics, IpcEnvelope, LastShutdown, Project, ProviderId, ProviderStatus, Result } from '@relay/contracts';
import type { CredentialVault } from '../../credentials.js';
import type { DialogService, FileFilter } from '../../dialogs.js';
import type { SampleService } from '../../samples.js';
import type { SupervisorSnapshot } from '../../runner-supervisor.js';
import type { CompositeChannel, HandlerTable, ParsedIn, RunnerRequester } from '../types.js';

/** Dependencies of {@link createCompositeHandlers}. */
export interface CompositeDeps {
  readonly runner: RunnerRequester;
  readonly dialogs: DialogService;
  readonly vault: CredentialVault;
  readonly samples: SampleService;
  readonly supervisorState: () => SupervisorSnapshot;
  readonly appInfo: () => AppInfo;
  readonly homeDir: string;
  readonly clock: Clock;
  /**
   * Writes a NEW file at `absPath` (or `name (2).ext`, `(3)`, … when taken): temp file + no-clobber link, never
   * overwriting and never following a symlink at the destination. Resolves the absolute path actually written.
   */
  readonly writeNewTextFile: (absPath: string, text: string) => Promise<string>;
  /** Absolute path of `relay.sqlite` (diagnostics report its size and display path even while the runner is down). */
  readonly dbFile: string;
  /** Size in bytes of a regular file, or null when it is missing / unreadable. */
  readonly fileSize: (absPath: string) => Promise<number | null>;
  /** True while main's log file cannot be written. */
  readonly loggingDegraded: () => boolean;
  /** How the previous session ended (null on first launch). */
  readonly lastShutdown: () => LastShutdown | null;
  /** Push `providers.changed` to windows after connect/disconnect. */
  readonly notifyProvidersChanged: () => void;
}

const fail = (error: AppError) => ({ ok: false as const, error });
const JSON_FILTER: FileFilter[] = [{ name: 'JSON', extensions: ['json'] }];
const CSV_FILTER: FileFilter[] = [{ name: 'CSV', extensions: ['csv'] }];

/** Filename-safe slug of a user-supplied name. */
export function fileSlug(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return slug === '' ? 'export' : slug;
}

/** Overlays main's session-only keys on the runner's provider list (session keys exist only in main memory). */
export function overlaySessionKeys(list: readonly ProviderStatus[], vault: CredentialVault): ProviderStatus[] {
  return list.map((s) => {
    if (vault.hasSession(s.providerId)) return { ...s, connected: true, storage: 'session', redactedLabel: vault.sessionLabel(s.providerId) };
    if (s.storage === 'session') return { ...s, connected: false, storage: 'none', redactedLabel: null };
    return s;
  });
}

/** The runner-owned half while the runner is down (main fills in the DB file facts it can read from disk). */
function degradedDiagnostics(): Omit<Diagnostics, 'runner' | 'secureStorage'> {
  return { db: { schemaVersion: 0, migrationsPending: 0, sizeBytes: 0 }, unresolvedAttempts: 0, catalog: { version: null, models: 0 }, prompts: { loaded: 0 } };
}

/** `relay.sqlite` + its `-wal` file, on disk (a large uncheckpointed WAL is part of what the database occupies). */
export async function dbSizeOnDisk(dbFile: string, fileSize: (p: string) => Promise<number | null>): Promise<number> {
  const [main, wal] = await Promise.all([fileSize(dbFile), fileSize(`${dbFile}-wal`)]);
  return (main ?? 0) + (wal ?? 0);
}

/** A keyed async mutex: `run(key, fn)` runs `fn` after every earlier `fn` for the same key settled. */
export function createKeyedMutex(): { run<T>(key: string, fn: () => Promise<T>): Promise<T> } {
  const tails = new Map<string, Promise<unknown>>();
  return {
    run(key, fn) {
      const prev = tails.get(key) ?? Promise.resolve();
      const next = prev.then(fn, fn);
      const tail = next.catch(() => undefined);
      tails.set(key, tail);
      void tail.then(() => {
        if (tails.get(key) === tail) tails.delete(key);
      });
      return next;
    },
  };
}

/** Creates the composite handler table. */
export function createCompositeHandlers(d: CompositeDeps): HandlerTable<CompositeChannel> {
  const display = (p: string): string => toDisplayPath(p, d.homeDir);
  // connect/disconnect of one provider never interleave (two connects would otherwise both read the same
  // `previous` ref and orphan one vault file).
  const providerLock = createKeyedMutex();
  // Two quick clicks on "Try the sample project" must not both copy it.
  const sampleLock = createKeyedMutex();

  /** The live (not archived) sample project, if any. */
  const existingSample = async (): Promise<Project | null> => {
    const list = await d.runner.request('relay/v1/projects.list', {});
    return list.ok ? (list.data.find((p) => p.isDemo && p.archivedAt === null) ?? null) : null;
  };

  const lookupRef = async (providerId: ProviderId): Promise<CredentialRef | undefined> => {
    const refs = await d.runner.request('relay/v1/providers.listCredentialRefs', {});
    return refs.ok ? refs.data.find((r) => r.providerId === providerId) : undefined;
  };

  const listProviders = async (): Promise<IpcEnvelope<ProviderStatus[]>> => {
    const r = await d.runner.request('relay/v1/providers.list', {});
    return r.ok ? { ok: true, data: overlaySessionKeys(r.data, d.vault) } : r;
  };

  const statusOf = async (providerId: ProviderId): Promise<IpcEnvelope<ProviderStatus>> => {
    const list = await listProviders();
    if (!list.ok) return list;
    const s = list.data.find((p) => p.providerId === providerId);
    return s === undefined ? fail(errors.notFound('provider')) : { ok: true, data: s };
  };

  const getDiagnostics = async (): Promise<IpcEnvelope<Diagnostics>> => {
    const [r, storage, sizeBytes] = await Promise.all([
      d.runner.request('relay/v1/app.getDiagnostics', {}), d.vault.status(), dbSizeOnDisk(d.dbFile, d.fileSize),
    ]);
    const sup = d.supervisorState();
    const runner = {
      state: sup.state, pid: sup.pid ?? null, lastHeartbeatAt: sup.lastHeartbeatAt ?? null, restarts: sup.restarts, lastFatal: sup.lastFatal ?? null,
    };
    const secureStorage = { available: storage.available, backend: storage.backend };
    const mainHalf = { runner, secureStorage, loggingDegraded: d.loggingDegraded(), lastShutdown: d.lastShutdown() };
    const dbFacts = { sizeBytes, displayPath: display(d.dbFile) };
    if (r.ok) return { ok: true, data: { ...r.data, ...mainHalf, db: { ...r.data.db, ...dbFacts } } };
    if (r.error.code !== 'RUNNER_UNAVAILABLE') return r;
    const degraded = degradedDiagnostics();
    return { ok: true, data: { ...degraded, ...mainHalf, db: { ...degraded.db, ...dbFacts } } };
  };

  const saveTo = async (defaultName: string, filters: FileFilter[]): Promise<Result<string | null>> => d.dialogs.pickSaveFile(defaultName, filters);

  /** Deletes every vault file no credential ref points at (best effort: a failed listing prunes nothing). */
  const pruneOrphans = async (): Promise<void> => {
    const refs = await d.runner.request('relay/v1/providers.listCredentialRefs', {});
    if (!refs.ok) return;
    const referenced = new Set<string>();
    for (const r of refs.data) if (r.vaultFile !== null) referenced.add(r.vaultFile);
    await d.vault.pruneUnreferenced(referenced).catch(() => undefined);
  };

  const connect = (input: ParsedIn<'relay/v1/providers.connect'>): Promise<IpcEnvelope<ProviderStatus>> =>
    providerLock.run(input.providerId, async () => {
      const previous = await lookupRef(input.providerId);
      const saved = await d.vault.save(input.providerId, input.apiKey, input.storage);
      if (!saved.ok) return fail(saved.error);
      const rec = await d.runner.request('relay/v1/providers.recordCredentialRef', {
        providerId: input.providerId, storageMode: saved.value.storageMode, vaultFile: saved.value.vaultFile, redactedLabel: saved.value.redactedLabel,
      });
      if (!rec.ok) {
        await d.vault.discard(input.providerId, saved.value); // also restores a session key the save removed
        return rec;
      }
      d.vault.commit(input.providerId, saved.value);
      if (previous?.vaultFile != null && previous.vaultFile !== saved.value.vaultFile) await d.vault.deleteVaultFile(previous.vaultFile);
      await pruneOrphans();
      d.notifyProvidersChanged();
      return statusOf(input.providerId);
    });

  const exportDiagnostics = async (input: ParsedIn<'relay/v1/app.exportDiagnostics'>) => {
    const diag = await getDiagnostics();
    const runs = await Promise.all((input.includeRunIds ?? []).map((runId) => d.runner.request('relay/v1/runs.get', { runId })));
    const payload = redactDeep({
      generatedAt: new Date(d.clock.now()).toISOString(),
      app: d.appInfo(),
      diagnostics: diag.ok ? diag.data : { error: diag.error.code },
      runs: runs.map((r) => (r.ok ? r.data : { error: r.error.code })),
    });
    const dest = await saveTo(`relay-diagnostics-${new Date(d.clock.now()).toISOString().slice(0, 10)}.json`, JSON_FILTER);
    if (!dest.ok) return fail(dest.error);
    if (dest.value === null) return { ok: true as const, data: { exported: false } };
    let written: string;
    try {
      written = await d.writeNewTextFile(dest.value, `${JSON.stringify(payload, null, 2)}\n`);
    } catch {
      return fail(errors.artifactWriteFailed());
    }
    return { ok: true as const, data: { exported: true, displayPath: display(written) } };
  };

  return {
    'relay/v1/app.getDiagnostics': getDiagnostics,
    'relay/v1/app.exportDiagnostics': exportDiagnostics,

    'relay/v1/projects.previewFiles': async (input) => {
      const extraExclusions = input.extraExclusions ?? [];
      if ('selectionId' in input) {
        const sel = d.dialogs.resolveSelection(input.selectionId);
        if (!sel.ok) return fail(sel.error);
        return d.runner.request('relay/v1/projects.previewRoot', { rootRealpath: sel.value.realpath, extraExclusions });
      }
      return d.runner.request('relay/v1/projects.previewRoot', { projectId: input.projectId, extraExclusions });
    },

    'relay/v1/projects.create': async (input) => {
      const sel = d.dialogs.resolveSelection(input.selectionId);
      if (!sel.ok) return fail(sel.error);
      const r = await d.runner.request('relay/v1/projects.createFromRoot', {
        idempotencyKey: input.idempotencyKey, rootRealpath: sel.value.realpath, rootDisplayPath: sel.value.displayPath, name: input.name,
        exclusions: input.exclusions ?? [], allowedProviderIds: input.allowedProviderIds,
        monthlyAllowanceMicrousd: input.monthlyAllowanceMicrousd ?? null, isDemo: false,
      });
      if (r.ok) d.dialogs.consumeSelection(input.selectionId); // a failed create keeps the token until TTL (retry)
      return r;
    },

    'relay/v1/projects.relocate': async (input) => {
      const sel = d.dialogs.resolveSelection(input.selectionId);
      if (!sel.ok) return fail(sel.error);
      const r = await d.runner.request('relay/v1/projects.relocateRoot', {
        projectId: input.projectId, rootRealpath: sel.value.realpath, rootDisplayPath: sel.value.displayPath,
        ...(input.confirm === undefined ? {} : { confirm: input.confirm }),
      });
      // CONFLICT root_unverified keeps the token: the UI shows the verification and re-calls with confirm: true.
      if (r.ok) d.dialogs.consumeSelection(input.selectionId);
      return r;
    },

    'relay/v1/projects.createSample': (input) =>
      sampleLock.run('sample', async () => {
        // A sample project that already exists (and is not archived) is reused: never one more copy per click.
        const existing = await existingSample();
        if (existing !== null) return { ok: true, data: existing };
        const copy = await d.samples.copySample(input.idempotencyKey);
        if (!copy.ok) return fail(copy.error);
        return d.runner.request('relay/v1/projects.createFromRoot', { idempotencyKey: input.idempotencyKey, ...copy.value.createInput, isDemo: true });
      }),

    'relay/v1/projects.export': async (input) => {
      const project = await d.runner.request('relay/v1/projects.get', { projectId: input.projectId });
      if (!project.ok) return project;
      const dest = await saveTo(`relay-project-${fileSlug(project.data.name)}.json`, JSON_FILTER);
      if (!dest.ok) return fail(dest.error);
      if (dest.value === null) return { ok: true, data: { exported: false } };
      const w = await d.runner.request('relay/v1/projects.exportTo', {
        projectId: input.projectId, destinationRealpath: dest.value, ...(input.runIds === undefined ? {} : { runIds: input.runIds }),
      });
      return w.ok ? { ok: true, data: { exported: true, displayPath: display(w.data.writtenRealpath) } } : w;
    },

    'relay/v1/ledger.export': async (input) => {
      const label = 'runId' in input ? input.runId : `${input.projectId}-${input.month}`;
      const dest = await saveTo(`relay-ledger-${label}.csv`, CSV_FILTER);
      if (!dest.ok) return fail(dest.error);
      if (dest.value === null) return { ok: true, data: { exported: false } };
      const w = await d.runner.request('relay/v1/ledger.exportTo', { ...input, destinationRealpath: dest.value });
      return w.ok ? { ok: true, data: { exported: true, displayPath: display(w.data.writtenRealpath) } } : w;
    },

    'relay/v1/artifacts.export': async (input) => {
      const dir = await d.dialogs.pickExportDir();
      if (!dir.ok) return fail(dir.error);
      if (dir.value === null) return { ok: true, data: { exported: false, displayPaths: [] } };
      const w = await d.runner.request('relay/v1/artifacts.exportTo', { runId: input.runId, what: input.what, destinationRealpath: dir.value });
      if (!w.ok) return w;
      return {
        ok: true,
        data: {
          exported: true,
          displayPaths: w.data.writtenRealpaths.map(display),
          // Partial exports (E2 #10): per-part written / failed, so the UI can retry only the failed parts.
          ...(w.data.written === undefined ? {} : { written: w.data.written.map((x) => ({ what: x.what, displayPath: display(x.realpath) })) }),
          ...(w.data.failed === undefined ? {} : { failed: w.data.failed }),
        },
      };
    },

    'relay/v1/artifacts.importDiff': async (input) => {
      const file = await d.dialogs.pickDiffFile();
      if (!file.ok) return fail(file.error);
      if (file.value === null) return { ok: true, data: null };
      return d.runner.request('relay/v1/artifacts.importDiffText', { projectId: input.projectId, text: file.value.text, fileName: file.value.fileName });
    },

    'relay/v1/providers.list': listProviders,
    'relay/v1/providers.connect': connect,

    'relay/v1/providers.disconnect': (input) =>
      providerLock.run(input.providerId, async () => {
        await d.vault.remove(input.providerId);
        const r = await d.runner.request('relay/v1/providers.deleteCredentialRef', { providerId: input.providerId });
        if (!r.ok) return r;
        d.notifyProvidersChanged();
        return statusOf(input.providerId);
      }),

    'relay/v1/providers.test': async (input) => {
      if (!d.vault.hasSession(input.providerId)) {
        const ref = await lookupRef(input.providerId);
        if (ref === undefined || ref.storageMode === 'session') {
          return fail(appError('AUTH_REQUIRED', { userMessage: 'Connect this provider before testing it.', details: { providerId: input.providerId } }));
        }
      }
      return d.runner.request('relay/v1/providers.test', { providerId: input.providerId });
    },
  };
}
