import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { INPUT_CAPS, createIdGen, epochMs } from '@relay/contracts';
import type { SelectionId } from '@relay/contracts';
import { createDialogService, validateProjectRoot } from './dialogs.js';
import type { NativeDialogs, RelayDialogsSeam } from './dialogs.js';
import { makeTempDir, removeTempDir } from './testing/temp-dirs.js';

const HOME = '/Users/alice';
const policy = { homeDir: HOME, userDataDir: `${HOME}/Library/Application Support/Relay` };

describe('validateProjectRoot', () => {
  it.each(['/', HOME, '/Users', '/System/Library', '/usr/local/x', '/private/etc', '/etc', `${HOME}/Library/Application Support/Relay/x`, `${HOME}/Library/Application Support`])(
    'rejects %s',
    (root) => {
      const r = validateProjectRoot(root, policy);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('PERMISSION_DENIED');
    },
  );

  it('accepts a project dir and an os.tmpdir() subdir', async () => {
    const tmp = await realpath(tmpdir());
    expect(validateProjectRoot(`${HOME}/code/app`, policy).ok).toBe(true);
    expect(validateProjectRoot(join(tmp, 'relay-e2e-x'), { homeDir: homedir(), userDataDir: join(tmp, 'ud') }).ok).toBe(true);
  });
});

describe('dialog service', () => {
  let dir = '';
  let now = 1_000_000;
  const clock = { now: () => epochMs(now) };
  const ids = createIdGen(clock, (n) => new Uint8Array(n).map((_, i) => i + now));
  const native = (overrides: Partial<NativeDialogs> = {}): NativeDialogs => ({
    showOpenDialog: () => Promise.resolve({ canceled: true, filePaths: [] }),
    showSaveDialog: () => Promise.resolve({ canceled: true }),
    ...overrides,
  });

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'relay-dlg-')));
    now = 1_000_000;
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns a token (never the realpath) and expires it after the TTL', async () => {
    const project = join(dir, 'proj');
    await mkdir(project);
    const svc = createDialogService({
      dialogs: native({ showOpenDialog: () => Promise.resolve({ canceled: false, filePaths: [project] }) }),
      clock, ids, homeDir: HOME, userDataDir: join(dir, 'ud'), e2e: false,
    });

    const picked = await svc.pickDirectory();

    expect(picked.ok).toBe(true);
    const sel = picked.ok ? picked.value : null;
    expect(sel?.selectionId).toMatch(/^sel_/);
    expect(JSON.stringify(sel)).not.toContain('realpath');
    const resolved = svc.resolveSelection(sel?.selectionId as SelectionId);
    expect(resolved.ok && resolved.value.realpath).toBe(project);
    now += 10 * 60 * 1000;
    const expired = svc.resolveSelection(sel?.selectionId as SelectionId);
    expect(!expired.ok && expired.error.code).toBe('NOT_FOUND');
  });

  it('prunes expired, never-resolved selection tokens on each new selection', async () => {
    const project = join(dir, 'proj');
    await mkdir(project);
    const svc = createDialogService({
      dialogs: native({ showOpenDialog: () => Promise.resolve({ canceled: false, filePaths: [project] }) }),
      clock, ids, homeDir: HOME, userDataDir: join(dir, 'ud'), e2e: false,
    });

    await svc.pickDirectory();
    now += 1_000;
    await svc.pickDirectory();
    expect(svc.pendingSelections()).toBe(2);
    now += 10 * 60 * 1000;
    const fresh = await svc.pickDirectory();

    expect(svc.pendingSelections()).toBe(1);
    expect(fresh.ok && fresh.value !== null && svc.resolveSelection(fresh.value.selectionId).ok).toBe(true);
  });

  it('consumeSelection makes the token unusable', async () => {
    const svc = createDialogService({ dialogs: native(), clock, ids, homeDir: HOME, userDataDir: join(dir, 'ud'), e2e: true, seamTarget: {} });
    const target: Record<string, unknown> = {};
    const svc2 = createDialogService({ dialogs: native(), clock, ids, homeDir: HOME, userDataDir: join(dir, 'ud'), e2e: true, seamTarget: target });
    (target['__relayDialogs'] as RelayDialogsSeam).setStub({ directory: dir });
    const picked = await svc2.pickDirectory();
    const id = picked.ok && picked.value !== null ? picked.value.selectionId : ('' as SelectionId);

    svc2.consumeSelection(id);

    expect(svc2.resolveSelection(id).ok).toBe(false);
    expect((await svc.pickDirectory()).ok).toBe(true);
  });

  it('installs __relayDialogs only with RELAY_E2E=1; setStub merges and clear restores native dialogs', async () => {
    const off: Record<string, unknown> = {};
    createDialogService({ dialogs: native(), clock, ids, homeDir: HOME, userDataDir: join(dir, 'ud'), e2e: false, seamTarget: off });
    expect(off['__relayDialogs']).toBeUndefined();

    const on: Record<string, unknown> = {};
    const svc = createDialogService({ dialogs: native(), clock, ids, homeDir: HOME, userDataDir: join(dir, 'ud'), e2e: true, seamTarget: on });
    const seam = on['__relayDialogs'] as RelayDialogsSeam;
    const diff = join(dir, 'a.diff');
    await writeFile(diff, 'diff --git a/x b/x\n');
    seam.setStub({ exportDir: dir });
    seam.setStub({ diffFile: diff });

    expect(await svc.pickExportDir()).toEqual({ ok: true, value: dir });
    expect(await svc.pickDiffFile()).toEqual({ ok: true, value: { text: 'diff --git a/x b/x\n', fileName: 'a.diff' } });
    expect(await svc.pickSaveFile('r.json', [])).toEqual({ ok: true, value: join(dir, 'r.json') });
    seam.clear();
    expect(await svc.pickExportDir()).toEqual({ ok: true, value: null });
  });

  it('validates stubbed directories like real ones', async () => {
    const target: Record<string, unknown> = {};
    const userData = join(dir, 'ud');
    await mkdir(join(userData, 'inner'), { recursive: true });
    const svc = createDialogService({ dialogs: native(), clock, ids, homeDir: HOME, userDataDir: userData, e2e: true, seamTarget: target });
    (target['__relayDialogs'] as RelayDialogsSeam).setStub({ directory: join(userData, 'inner') });

    const r = await svc.pickDirectory();

    expect(!r.ok && r.error.code).toBe('PERMISSION_DENIED');
  });
});

describe('pickDiffFile size cap (H3)', () => {
  let tmp = '';
  const clock = { now: () => epochMs(1) };
  const ids = createIdGen(clock, (n) => new Uint8Array(n));
  const service = (stub: string) => {
    const target: Record<string, unknown> = {};
    const svc = createDialogService({
      dialogs: { showOpenDialog: () => Promise.reject(new Error('native dialog must not open')), showSaveDialog: () => Promise.resolve({ canceled: true }) },
      clock, ids, homeDir: HOME, userDataDir: join(tmp, 'ud'), e2e: true, seamTarget: target,
    });
    (target['__relayDialogs'] as RelayDialogsSeam).setStub({ diffFile: stub });
    return svc;
  };

  beforeEach(async () => {
    tmp = await makeTempDir('dlgcap');
  });
  afterEach(async () => {
    await removeTempDir(tmp);
  });

  it('rejects a diff larger than 1 MiB with VALIDATION_FAILED too_large and never returns its text', async () => {
    const big = join(tmp, 'big.diff');
    await writeFile(big, 'x'.repeat(INPUT_CAPS.maxDiffBytes + 1));

    const r = await service(big).pickDiffFile();

    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.code).toBe('VALIDATION_FAILED');
    expect(!r.ok && r.error.details?.['issues']).toEqual([{ path: 'file', message: 'Choose a diff file of at most 1 MiB.', code: 'too_large' }]);
  });

  it('accepts a diff of exactly 1 MiB', async () => {
    const edge = join(tmp, 'edge.diff');
    await writeFile(edge, 'y'.repeat(INPUT_CAPS.maxDiffBytes));

    const r = await service(edge).pickDiffFile();

    expect(r.ok && r.value?.text.length).toBe(INPUT_CAPS.maxDiffBytes);
    expect(r.ok && r.value?.fileName).toBe('edge.diff');
  });

  it('rejects a directory as the diff file', async () => {
    const r = await service(tmp).pickDiffFile();

    expect(!r.ok && r.error.code).toBe('VALIDATION_FAILED');
  });
});
