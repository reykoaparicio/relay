// 08 H3: native dialogs, realpath + root validation, and main-only selection tokens. The renderer never supplies a
// filesystem path (§12.5); it only ever holds a `sel_…` token and a display path.
import { readFile, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { INPUT_CAPS, SELECTION_TTL_MS, epochMs, err, errors, ok, toDisplayPath } from '@relay/contracts';
import type { Clock, DirectorySelection, IdGen, Result, SelectionId } from '@relay/contracts';

/** A save/open dialog file filter. */
export interface FileFilter {
  readonly name: string;
  readonly extensions: string[];
}

/** The subset of Electron's `dialog` main uses (bound to the main window by the composition root). */
export interface NativeDialogs {
  showOpenDialog(opts: {
    properties: ('openDirectory' | 'openFile' | 'createDirectory')[];
    filters?: FileFilter[];
  }): Promise<{ canceled: boolean; filePaths: string[] }>;
  showSaveDialog(opts: { defaultPath?: string; filters?: FileFilter[] }): Promise<{ canceled: boolean; filePath?: string }>;
}

/** E2E stub (12 §L2 `stubDialogs`): each set field replaces the matching native dialog. */
export interface DialogStub {
  directory?: string;
  diffFile?: string;
  exportDir?: string;
}

/** The `globalThis.__relayDialogs` seam, installed only when RELAY_E2E=1. */
export interface RelayDialogsSeam {
  setStub(s: DialogStub): void;
  clear(): void;
}

/** A resolved selection (main-only; the realpath never crosses to the renderer). */
export interface ResolvedSelection {
  readonly realpath: string;
  readonly displayPath: string;
}

/** Dialog + selection service. */
export interface DialogService {
  pickDirectory(): Promise<Result<DirectorySelection | null>>;
  resolveSelection(id: SelectionId): Result<ResolvedSelection>;
  consumeSelection(id: SelectionId): void;
  pickDiffFile(): Promise<Result<{ text: string; fileName: string } | null>>;
  pickExportDir(): Promise<Result<string | null>>;
  pickSaveFile(defaultName: string, filters: FileFilter[]): Promise<Result<string | null>>;
}

/** Dependencies of {@link createDialogService}. */
export interface DialogDeps {
  readonly dialogs: NativeDialogs;
  readonly clock: Clock;
  readonly ids: IdGen;
  readonly homeDir: string;
  readonly userDataDir: string;
  /** Installs the `__relayDialogs` seam when true (RELAY_E2E=1 only). */
  readonly e2e: boolean;
  /** Where the seam is installed (defaults to `globalThis`). */
  readonly seamTarget?: Record<string, unknown>;
  readonly caseInsensitive?: boolean;
}

/** Roots that may never be (or contain) a project, compared after realpath (so `/etc` → `/private/etc`). */
export const SYSTEM_ROOTS = ['/System', '/Library', '/usr', '/bin', '/sbin', '/etc', '/private/etc'] as const;

function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Options of {@link validateProjectRoot}; paths are realpaths. */
export interface RootPolicy {
  readonly homeDir: string;
  readonly userDataDir: string;
  readonly caseInsensitive?: boolean;
}

/**
 * Pure main-side root check (08 H3; the runner re-checks in 05 E1). Rejects `/`, the home dir and its ancestors,
 * system dirs (equal or inside), and anything equal to, inside, or containing userData. Tmpdir subdirs are allowed.
 */
export function validateProjectRoot(root: string, policy: RootPolicy): Result<void> {
  const norm = (p: string): string => (policy.caseInsensitive === true ? p.toLowerCase() : p);
  const r = norm(root);
  const home = norm(policy.homeDir);
  const userData = norm(policy.userDataDir);
  const unsafe =
    r === '/' ||
    isWithin(r, home) ||
    SYSTEM_ROOTS.some((d) => isWithin(norm(d), r)) ||
    isWithin(userData, r) ||
    isWithin(r, userData);
  if (!unsafe) return ok(undefined);
  return err(
    errors.permissionDenied('unsafe_root', {
      userMessage: 'This folder cannot be used as a project. Choose a specific project folder instead.',
    }),
  );
}

async function realpathOrNull(p: string): Promise<string | null> {
  try {
    return await realpath(p);
  } catch {
    return null;
  }
}

const DIFF_FILTERS: FileFilter[] = [{ name: 'Diff or patch', extensions: ['diff', 'patch'] }];

/** Creates the dialog service (and the E2E seam when `deps.e2e`). */
export function createDialogService(deps: DialogDeps): DialogService & { pendingSelections(): number } {
  const selections = new Map<SelectionId, ResolvedSelection & { expiresAt: number }>();
  let stub: DialogStub = {};
  const caseInsensitive = deps.caseInsensitive ?? process.platform === 'darwin';

  if (deps.e2e) {
    const seam: RelayDialogsSeam = {
      setStub: (s) => {
        stub = { ...stub, ...s };
      },
      clear: () => {
        stub = {};
      },
    };
    Reflect.set(deps.seamTarget ?? globalThis, '__relayDialogs', seam);
  }

  const openOne = async (properties: ('openDirectory' | 'openFile' | 'createDirectory')[], filters?: FileFilter[]) => {
    const res = await deps.dialogs.showOpenDialog(filters === undefined ? { properties } : { properties, filters });
    return res.canceled ? null : (res.filePaths[0] ?? null);
  };

  const policy = async (): Promise<RootPolicy> => ({
    homeDir: (await realpathOrNull(deps.homeDir)) ?? deps.homeDir,
    userDataDir: (await realpathOrNull(deps.userDataDir)) ?? deps.userDataDir,
    caseInsensitive,
  });

  return {
    async pickDirectory() {
      const chosen = stub.directory ?? (await openOne(['openDirectory', 'createDirectory']));
      if (chosen === null) return ok(null);
      const real = await realpathOrNull(chosen);
      if (real === null) return err(errors.notFound('directory'));
      const st = await stat(real);
      if (!st.isDirectory()) {
        return err(errors.validationFailed([{ path: 'directory', message: 'Choose a folder.', code: 'not_directory' }]));
      }
      const valid = validateProjectRoot(real, await policy());
      if (!valid.ok) return valid;
      const nowMs = deps.clock.now();
      for (const [id, sel] of selections) if (sel.expiresAt <= nowMs) selections.delete(id); // unused tokens never pile up
      const selectionId = deps.ids.next('selection');
      const expiresAt = epochMs(deps.clock.now() + SELECTION_TTL_MS);
      const displayPath = toDisplayPath(real, deps.homeDir);
      selections.set(selectionId, { realpath: real, displayPath, expiresAt });
      return ok({ selectionId, displayPath, expiresAt });
    },

    resolveSelection(id) {
      const s = selections.get(id);
      if (s === undefined) return err(errors.notFound('selection'));
      if (s.expiresAt <= deps.clock.now()) {
        selections.delete(id);
        return err(errors.notFound('selection'));
      }
      return ok({ realpath: s.realpath, displayPath: s.displayPath });
    },

    consumeSelection(id) {
      selections.delete(id);
    },

    pendingSelections: () => selections.size,

    async pickDiffFile() {
      const chosen = stub.diffFile ?? (await openOne(['openFile'], DIFF_FILTERS));
      if (chosen === null) return ok(null);
      const real = await realpathOrNull(chosen);
      if (real === null) return err(errors.notFound('diff_file'));
      const st = await stat(real);
      if (!st.isFile() || st.size > INPUT_CAPS.maxDiffBytes) {
        return err(errors.validationFailed([{ path: 'file', message: 'Choose a diff file of at most 1 MiB.', code: 'too_large' }]));
      }
      return ok({ text: await readFile(real, 'utf8'), fileName: basename(real) });
    },

    async pickExportDir() {
      const chosen = stub.exportDir ?? (await openOne(['openDirectory', 'createDirectory']));
      if (chosen === null) return ok(null);
      const real = await realpathOrNull(chosen);
      return real === null ? err(errors.notFound('directory')) : ok(real);
    },

    async pickSaveFile(defaultName, filters) {
      let chosen: string | null;
      if (stub.exportDir !== undefined) chosen = join(stub.exportDir, defaultName);
      else {
        const res = await deps.dialogs.showSaveDialog({ defaultPath: defaultName, filters });
        chosen = res.canceled || res.filePath === undefined || res.filePath === '' ? null : res.filePath;
      }
      if (chosen === null) return ok(null);
      const realParent = await realpathOrNull(dirname(chosen));
      return realParent === null ? err(errors.notFound('directory')) : ok(join(realParent, basename(chosen)));
    },
  };
}
