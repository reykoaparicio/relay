import { RelayError } from '@relay/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { toArtifactMeta } from '../mappers.js';
import type { FixtureDb } from '../testing/fixtures.js';
import { newId, openFixtureDb, seedAttempt, seedProject, seedRun, seedStep, sha } from '../testing/fixtures.js';
import type { ArtifactInsert } from '../types.js';

describe('ArtifactRepo', () => {
  let f: FixtureDb;

  beforeEach(async () => {
    f = await openFixtureDb();
  });
  afterEach(async () => {
    await f.db.dispose();
  });

  const setup = () => {
    const p = seedProject(f.db, f.clock);
    const run = seedRun(f.db, f.clock, p.id);
    const step = seedStep(f.db, f.clock, run.id);
    const attempt = seedAttempt(f.db, f.clock, run.id, step.id);
    const meta = (o: Partial<ArtifactInsert>): ArtifactInsert => {
      const id = o.id ?? newId('artifact');
      return {
        id,
        runId: run.id,
        projectId: p.id,
        stepRunId: step.id,
        attemptId: attempt.id,
        kind: 'raw_response',
        relPath: `artifacts/run/${id}`,
        sha256: sha('a'),
        sizeBytes: 10,
        mediaType: 'application/json',
        createdAt: f.clock.now(),
        ...o,
      };
    };
    return { p, run, meta };
  };

  it('insertIfAbsent is idempotent on (attempt, kind, sha256)', () => {
    const { meta } = setup();

    const first = f.db.repos.artifacts.insertIfAbsent(meta({}));
    const again = f.db.repos.artifacts.insertIfAbsent(meta({}));

    expect(again.id).toBe(first.id);
  });

  it('creates a second row for the same sha with a different kind', () => {
    const { meta, run } = setup();

    const raw = f.db.repos.artifacts.insertIfAbsent(meta({}));
    const out = f.db.repos.artifacts.insertIfAbsent(meta({ kind: 'findings', schemaId: 'findings.v1' }));

    expect(out.id).not.toBe(raw.id);
    expect(f.db.repos.artifacts.listForRun(run.id)).toHaveLength(2);
    expect(f.db.repos.artifacts.listForRun(run.id, ['findings']).map((a) => a.schemaId)).toEqual(['findings.v1']);
  });

  it('dedupes input files per run and findInputFile finds the row', () => {
    const { meta, run } = setup();
    const input = (): ArtifactInsert => meta({ kind: 'input_file', attemptId: null, stepRunId: null, sha256: sha('b') });

    const first = f.db.repos.artifacts.insertIfAbsent(input());
    const second = f.db.repos.artifacts.insertIfAbsent(input());

    expect(second.id).toBe(first.id);
    expect(f.db.repos.artifacts.findInputFile(run.id, sha('b'))?.id).toBe(first.id);
    expect(f.db.repos.artifacts.findInputFile(run.id, sha('c'))).toBeUndefined();
  });

  it('returns the existing row for a retried id and refuses a taken rel_path', () => {
    const { meta } = setup();
    const first = f.db.repos.artifacts.insertIfAbsent(meta({ kind: 'report', attemptId: null }));

    const retried = f.db.repos.artifacts.insertIfAbsent(meta({ id: first.id, kind: 'report', attemptId: null }));

    expect(retried.id).toBe(first.id);
    expect(() => f.db.repos.artifacts.insertIfAbsent(meta({ kind: 'plan', attemptId: null, relPath: first.relPath }))).toThrow();
  });

  it('markPurged sets purged_at once and the meta DTO exposes only a purged flag', () => {
    const { meta, p } = setup();
    const a = f.db.repos.artifacts.insertIfAbsent(meta({}));

    const first = f.db.repos.artifacts.markPurged(a.id, f.clock.now());
    const second = f.db.repos.artifacts.markPurged(a.id, f.clock.now());
    const row = f.db.repos.artifacts.get(a.id);

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(row?.purgedAt).toBe(f.clock.now());
    expect(row && toArtifactMeta(row).purged).toBe(true);
    expect(row && 'relPath' in toArtifactMeta(row)).toBe(false);
    expect(f.db.repos.artifacts.listWhere({ projectId: p.id, unpurgedOnly: true })).toEqual([]);
    expect(f.db.repos.artifacts.listWhere({ kinds: ['raw_response'], createdBefore: f.clock.now() })).toEqual([]);
    expect(f.db.repos.artifacts.get(newId('artifact'))).toBeUndefined();
  });

  it('refuses an id replay whose sha256, kind, or rel_path differs, and returns the row for a true replay (B4)', () => {
    const { meta } = setup();
    const first = f.db.repos.artifacts.insertIfAbsent(meta({ kind: 'report', attemptId: null }));
    const replay = (o: Partial<ArtifactInsert>) => () =>
      f.db.repos.artifacts.insertIfAbsent(meta({ id: first.id, kind: 'report', attemptId: null, relPath: first.relPath, ...o }));

    const codeOf = (fn: () => unknown): string | undefined => {
      try {
        fn();
        return undefined;
      } catch (e) {
        return e instanceof RelayError ? e.appError.code : 'not-a-relay-error';
      }
    };

    expect(codeOf(replay({ sha256: sha('z') }))).toBe('CONFLICT');
    expect(codeOf(replay({ kind: 'plan' }))).toBe('CONFLICT');
    expect(codeOf(replay({ relPath: 'artifacts/run/elsewhere' }))).toBe('CONFLICT');
    expect(replay({})().id).toBe(first.id);
    expect(f.db.repos.artifacts.get(first.id)?.sha256).toBe(sha('a'));
  });
});
