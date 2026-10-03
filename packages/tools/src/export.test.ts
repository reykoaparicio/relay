import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Result, RunId } from '@relay/contracts';
import { createIdGen } from '@relay/contracts';
import { createArtifactStore } from './artifact-store.js';
import { assertExportDestination, exportArtifacts, exportWriteHooks, isSafeFileName, writeExportFile } from './export.js';
import { artifactIds, fakeClock, tempDirs } from './testing/temp-dirs.js';

const tmp = tempDirs();
afterEach(async () => {
  await tmp.cleanup();
});

const bytes = (s: string) => new TextEncoder().encode(s);

/** base/{code/project, exports} */
async function layout() {
  const base = await tmp.make('relay-export-');
  const project = path.join(base, 'code', 'project');
  const exportsDir = path.join(base, 'exports');
  await fs.promises.mkdir(path.join(project, 'src'), { recursive: true });
  await fs.promises.mkdir(exportsDir);
  return { base, project, exportsDir };
}

function reasonOf(r: Result<unknown>): string {
  return r.ok ? 'ok' : `${r.error.code}:${String(r.error.details?.['reason'])}`;
}

describe('assertExportDestination', () => {
  it('refuses a destination inside (or equal to) a project root: inside_project', async () => {
    const { project } = await layout();

    const inside = await writeExportFile(path.join(project, 'src'), 'r.md', bytes('x'), [project]);
    const equal = await writeExportFile(project, 'r.md', bytes('x'), [project]);

    expect(reasonOf(inside)).toBe('PERMISSION_DENIED:inside_project');
    expect(reasonOf(equal)).toBe('PERMISSION_DENIED:inside_project');
    expect(await fs.promises.readdir(path.join(project, 'src'))).toEqual([]);
  });

  it('refuses a symlinked destination that resolves inside a project: inside_project', async () => {
    const { base, project } = await layout();
    const link = path.join(base, 'innocent');
    await fs.promises.symlink(path.join(project, 'src'), link);

    const r = await writeExportFile(link, 'r.md', bytes('x'), [project]);

    expect(reasonOf(r)).toBe('PERMISSION_DENIED:inside_project');
  });

  it('contains_project: refuses a destination that contains a project root', async () => {
    const { base, project } = await layout();

    const r = await writeExportFile(path.join(base, 'code'), 'r.md', bytes('x'), [project]);

    expect(reasonOf(r)).toBe('PERMISSION_DENIED:contains_project');
  });

  it('allows a sibling directory and a sibling with a shared name prefix', async () => {
    const { base, project, exportsDir } = await layout();
    const prefixSibling = path.join(base, 'code', 'project-exports');
    await fs.promises.mkdir(prefixSibling);

    expect((await assertExportDestination(exportsDir, [project])).ok).toBe(true);
    expect((await assertExportDestination(prefixSibling, [project])).ok).toBe(true);
  });

  it('matches a case-folded project root on a case-insensitive volume', async () => {
    const { project } = await layout();
    const folded = project.toUpperCase();
    const same = await fs.promises.stat(folded).then(
      () => true,
      () => false,
    );
    if (!same) return; // case-sensitive volume

    const r = await assertExportDestination(path.join(project, 'src'), [folded]);

    expect(reasonOf(r)).toBe('PERMISSION_DENIED:inside_project');
  });

  it('returns NOT_FOUND for a missing destination or a file', async () => {
    const { base, project } = await layout();
    await fs.promises.writeFile(path.join(base, 'file.txt'), 'x');

    expect(reasonOf(await assertExportDestination(path.join(base, 'missing'), [project]))).toBe('NOT_FOUND:undefined');
    expect(reasonOf(await assertExportDestination(path.join(base, 'file.txt'), [project]))).toBe('NOT_FOUND:undefined');
  });

  it('checks unregistered (missing) project roots by resolved path', async () => {
    const { base, exportsDir } = await layout();

    const r = await assertExportDestination(exportsDir, [path.join(base, 'exports', 'not-created-yet')]);

    expect(reasonOf(r)).toBe('PERMISSION_DENIED:contains_project');
  });
});

describe('writeExportFile', () => {
  it('writes with O_EXCL and suffixes names instead of overwriting', async () => {
    const { project, exportsDir } = await layout();

    const names = [];
    for (const content of ['one', 'two', 'three']) {
      const r = await writeExportFile(exportsDir, 'ledger.csv', bytes(content), [project]);
      names.push(r.ok ? r.value.fileName : r.error.code);
    }
    const noExt = await writeExportFile(exportsDir, 'bundle', bytes('b'), [project]);
    const noExt2 = await writeExportFile(exportsDir, 'bundle', bytes('b'), [project]);

    expect(names).toEqual(['ledger.csv', 'ledger (2).csv', 'ledger (3).csv']);
    expect(await fs.promises.readFile(path.join(exportsDir, 'ledger.csv'), 'utf8')).toBe('one');
    expect(noExt2.ok && [noExt.ok && noExt.value.fileName, noExt2.value.fileName]).toEqual(['bundle', 'bundle (2)']);
  });

  it.each(['a/b.csv', '..', '.', '', 'a\\b', 'a\0b', 'x'.repeat(256)])('rejects the unsafe name %j', async (name) => {
    const { project, exportsDir } = await layout();

    const r = await writeExportFile(exportsDir, name, bytes('x'), [project]);

    expect(r.ok || r.error.code).toBe('VALIDATION_FAILED');
    expect(isSafeFileName(name)).toBe(false);
  });

  it('returns ARTIFACT_WRITE_FAILED when the destination is not writable', async () => {
    const { project, exportsDir } = await layout();
    await fs.promises.chmod(exportsDir, 0o555);

    const r = await writeExportFile(exportsDir, 'r.md', bytes('x'), [project]);

    expect(r.ok || r.error.code).toBe('ARTIFACT_WRITE_FAILED');
  });
});

describe('exportArtifacts', () => {
  async function storeWith(texts: string[]) {
    const userDataDir = await tmp.make('relay-ud-');
    const clock = fakeClock();
    const store = createArtifactStore({ userDataDir, clock });
    const runId: RunId = createIdGen(clock, (n) => new Uint8Array(n)).next('run');
    const newId = artifactIds();
    const relPaths: string[] = [];
    for (const t of texts) {
      const r = await store.put({ scopeDir: `artifacts/${runId}`, artifactId: newId(), bytes: bytes(t), mediaType: 'text/markdown' });
      if (!r.ok) throw new Error('put');
      relPaths.push(r.value.relPath);
    }
    return { store, relPaths };
  }

  it('exports artifacts with name suffixing and never overwrites', async () => {
    const { project, exportsDir } = await layout();
    const { store, relPaths } = await storeWith(['# report', 'diff']);
    const files = [
      { relPath: relPaths[0] ?? '', suggestedName: 'report.md' },
      { relPath: relPaths[1] ?? '', suggestedName: 'report.md' },
    ];

    const first = await exportArtifacts({ files, destinationRealpath: exportsDir, projectRoots: [project], store });
    const again = await exportArtifacts({ files: files.slice(0, 1), destinationRealpath: exportsDir, projectRoots: [project], store });

    expect(first).toEqual({ ok: true, value: { written: ['report.md', 'report (2).md'], failed: [] } });
    expect(again).toEqual({ ok: true, value: { written: ['report (3).md'], failed: [] } });
    expect(await fs.promises.readFile(path.join(exportsDir, 'report (2).md'), 'utf8')).toBe('diff');
  });

  it('refuses a destination inside a project, and a destination that contains_project', async () => {
    const { base, project } = await layout();
    const { store, relPaths } = await storeWith(['x']);
    const files = [{ relPath: relPaths[0] ?? '', suggestedName: 'r.md' }];

    const inside = await exportArtifacts({ files, destinationRealpath: project, projectRoots: [project], store });
    const contains = await exportArtifacts({ files, destinationRealpath: base, projectRoots: [project], store });

    expect(reasonOf(inside)).toBe('PERMISSION_DENIED:inside_project');
    expect(reasonOf(contains)).toBe('PERMISSION_DENIED:contains_project');
  });

  it('E2 #10: a purged artifact fails on its own; the other file is still written and reported, and unsafe names are rejected', async () => {
    const { project, exportsDir } = await layout();
    const { store, relPaths } = await storeWith(['a', 'b']);
    await store.purge(relPaths[1] ?? '');
    const files = relPaths.map((relPath, i) => ({ relPath, suggestedName: `f${String(i)}.md` }));

    const partial = await exportArtifacts({ files, destinationRealpath: exportsDir, projectRoots: [project], store });
    const onlyPurged = await exportArtifacts({ files: files.slice(1), destinationRealpath: exportsDir, projectRoots: [project], store });
    const unsafe = await exportArtifacts({ files: [{ relPath: relPaths[0] ?? '', suggestedName: '../x' }], destinationRealpath: exportsDir, projectRoots: [project], store });

    expect(partial.ok && partial.value).toEqual({ written: ['f0.md'], failed: [{ suggestedName: 'f1.md', code: 'NOT_FOUND' }] });
    expect(onlyPurged.ok || [onlyPurged.error.code, onlyPurged.error.details?.['purged'], onlyPurged.error.details?.['failed']])
      .toEqual(['NOT_FOUND', true, [{ suggestedName: 'f1.md', code: 'NOT_FOUND' }]]);
    expect(await fs.promises.readdir(exportsDir)).toEqual(['f0.md']);
    expect(unsafe.ok || unsafe.error.code).toBe('VALIDATION_FAILED');
  });

  it('E2 #9: a write that fails part-way leaves no 0-byte or partial file, and no temp file', async () => {
    const { project, exportsDir } = await layout();
    const { store, relPaths } = await storeWith(['a']);
    exportWriteHooks.beforePublish = () => Promise.reject(Object.assign(new Error('ENOSPC: no space left'), { code: 'ENOSPC' }));
    try {
      const r = await exportArtifacts({ files: [{ relPath: relPaths[0] ?? '', suggestedName: 'a.md' }], destinationRealpath: exportsDir, projectRoots: [project], store });
      const w = await writeExportFile(exportsDir, 'b.csv', new Uint8Array([1, 2, 3]), [project]);

      expect(r.ok || r.error.code).toBe('ARTIFACT_WRITE_FAILED');
      expect(w.ok || w.error.code).toBe('ARTIFACT_WRITE_FAILED');
      expect(await fs.promises.readdir(exportsDir)).toEqual([]);
    } finally {
      delete exportWriteHooks.beforePublish;
    }
    const again = await writeExportFile(exportsDir, 'b.csv', new Uint8Array([1, 2, 3]), [project]);
    expect(again.ok && again.value.fileName).toBe('b.csv');
    expect(await fs.promises.readdir(exportsDir)).toEqual(['b.csv']);
  });

  it('returns ARTIFACT_WRITE_FAILED when writing fails', async () => {
    const { project, exportsDir } = await layout();
    const { store, relPaths } = await storeWith(['a']);
    await fs.promises.chmod(exportsDir, 0o555);

    const r = await exportArtifacts({ files: [{ relPath: relPaths[0] ?? '', suggestedName: 'a.md' }], destinationRealpath: exportsDir, projectRoots: [project], store });

    expect(r.ok || r.error.code).toBe('ARTIFACT_WRITE_FAILED');
  });
});
