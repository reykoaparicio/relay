/**
 * K7 (11 §K7): generates `tests/fixtures/databases/v1-populated.sqlite` — a database with runs, memory, and a ledger —
 * by running the fake scenarios `happy-path`, `budget-exhaustion`, and `unknown-outcome` against a fresh userData dir
 * through `createRuntime`, then copying out a checkpointed (`wal_checkpoint(TRUNCATE)`) `relay.sqlite`.
 *
 * Run: `tsx --conditions=development tests/helpers/make-fixture-db.ts [outPath]`. Re-run whenever a migration is added.
 * The machine-specific project realpath is replaced by a neutral placeholder so the committed file leaks no local path.
 */
import './no-network.js';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { createIdGen, epochMs, systemClock } from '@relay/contracts';
import type { RunId, RunStatus } from '@relay/contracts';
import { createHarness } from './engine-harness.js';
import type { Harness } from './engine-harness.js';
import { cleanupTempDirs, copyFixture, makeTempDir } from './temp-dirs.js';

export const FIXTURE_DB_PATH = fileURLToPath(new URL('../fixtures/databases/v1-populated.sqlite', import.meta.url));
/** Placeholder stored instead of the generator machine's temp realpath. */
export const FIXTURE_DB_PROJECT_ROOT = '/relay-fixture/sample-api';

const done = (s: RunStatus): boolean => !['queued', 'running'].includes(s);

async function runScenario(userDataDir: string, projectRoot: string, scenario: string, drive: (h: Harness, runId: RunId) => Promise<void>, budgetMicrousd?: number): Promise<void> {
  const h = await createHarness({ userDataDir, projectRoot, scenario });
  try {
    const runId = await h.startRun({ key: `fixture-db-${scenario}`, ...(budgetMicrousd === undefined ? {} : { limits: { budgetMicrousd } }) });
    await drive(h, runId);
  } finally {
    await h.dispose();
  }
}

/** Seeds approved + suggested memory records (the memory service itself lands in Wave 3; the rows are storage-level). */
async function seedMemory(userDataDir: string, projectRoot: string): Promise<void> {
  const h = await createHarness({ userDataDir, projectRoot, start: false });
  try {
    const now = epochMs(Date.now());
    const runs = h.db.repos.runs.list({ projectId: h.projectId, limit: 10, sort: 'created_asc' });
    const sourceRunId = runs.ok ? (runs.value.items[0]?.id ?? null) : null;
    const ids = createIdGen(systemClock, (n) => new Uint8Array(randomBytes(n)));
    h.db.tx('immediate', (r) => {
      const approved = r.memory.insertRecord(
        { id: ids.next('memory'), projectId: h.projectId, type: 'project_decision', status: 'approved', scope: { roles: 'all' }, createdAt: now, sourceRunId },
        { id: ids.next('memoryRevision'), title: 'Validate request fields with src/lib/validate.ts helpers',
          content: 'Handlers validate every body field with the helpers in src/lib/validate.ts instead of casting.', sourceRefs: [], author: 'user', createdAt: now },
      );
      r.memory.recordEvent({ recordId: approved.record.id, event: 'approved', revision: 1, actor: 'user', createdAt: now });
      r.memory.insertRecord(
        { id: ids.next('memory'), projectId: h.projectId, type: 'user_rule', status: 'suggested', scope: { roles: 'all' }, createdAt: now, sourceRunId },
        { id: ids.next('memoryRevision'), title: 'Public response format', content: 'Responses are { data } or { error: { code, message } }.',
          sourceRefs: [], author: sourceRunId === null ? 'user' : `run:${sourceRunId}`, createdAt: now },
      );
    });
  } finally {
    await h.dispose();
  }
}

/** Generates the fixture DB at `outPath`. Returns the path. */
export async function makeFixtureDb(outPath: string = FIXTURE_DB_PATH): Promise<string> {
  const userDataDir = await makeTempDir('relay-fixture-db-ud-');
  const projectRoot = await copyFixture('sample-api');
  try {
    await runScenario(userDataDir, projectRoot, 'happy-path', async (h, runId) => {
      await h.waitFor(runId, 'awaiting_approval');
      await h.approve(runId);
      await h.waitFor(runId, (r) => done(r.status));
      await h.waitUntil(() => h.db.repos.artifacts.listForRun(runId, ['report']).length > 0, 10_000, 'report');
    });
    await runScenario(userDataDir, projectRoot, 'budget-exhaustion', async (h, runId) => {
      await h.waitFor(runId, (r) => done(r.status));
    }, 20_000);
    await runScenario(userDataDir, projectRoot, 'unknown-outcome', async (h, runId) => {
      await h.waitFor(runId, 'awaiting_approval');
      await h.approve(runId);
      await h.waitFor(runId, (r) => done(r.status));
    });
    await seedMemory(userDataDir, projectRoot);

    const src = join(userDataDir, 'relay.sqlite');
    const db = new DatabaseSync(src);
    try {
      db.prepare('UPDATE projects SET root_realpath = ?, root_display_path = ?').run(FIXTURE_DB_PROJECT_ROOT, '~/sample-api');
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } finally {
      db.close();
    }
    await mkdir(dirname(outPath), { recursive: true });
    await rm(outPath, { force: true });
    await copyFile(src, outPath);
    return outPath;
  } finally {
    await cleanupTempDirs(); // only the dirs this process created (userData + the fixture copy's temp parent)
  }
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  const out = await makeFixtureDb(process.argv[2] ?? FIXTURE_DB_PATH);
  console.log(`wrote ${out}`);
}
