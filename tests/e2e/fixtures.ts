// 12 §L2 Electron fixture: launches the unpackaged build (apps/desktop → out/main/index.js) with the Electron binary
// from apps/desktop's own devDependency, a temp userData profile, fake providers, and a per-test copy of the
// sample-api fixture whose tree hash must be unchanged after the test (FR-10 / §3.3).
import { test as base, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page, TestInfo } from '@playwright/test';
import { createRequire } from 'node:module';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FakeCall, FakeLogEntry } from '@relay/providers';
import { SAMPLE_API_ROOT, computeFixtureManifest } from '../helpers/fixture-hash.js';
import { makeTempDir, safeRemove } from './safe-remove.js';

const desktopDir = path.resolve('apps/desktop');
// The Electron binary path, resolved from apps/desktop's devDependency (the root has no `electron`, 01 §R4-13).
const electronPath = createRequire(path.join(desktopDir, 'package.json'))('electron') as unknown as string;

/** The fake secret the onboarding spec places in the project copy (never committed; never sent). */
export const FIXTURE_ENV_SECRET = 'SAMPLE_API_TOKEN=sk-fixture-DO-NOT-READ-1234567890';

export interface DialogStub {
  directory?: string;
  diffFile?: string;
  exportDir?: string;
}

export interface PerfMeasure {
  readonly name: string;
  readonly duration: number;
  readonly startTime: number;
}

interface LaunchOptions {
  readonly userDataDir: string;
  readonly scenario: string;
  readonly crashAt?: string | undefined;
}

/** The live Electron session; `relaunch()` swaps it for a new app on the same userData. */
interface Session {
  app: ElectronApplication;
  page: Page;
  launches: number;
}

export interface ProjectCopy {
  /** Realpath of the temp project copy (outside userData, a valid project root). */
  readonly dir: string;
  /** Folder name, which onboarding proposes as the project name. */
  readonly name: string;
  /** Tree hash taken after setup, before the app touched anything. */
  readonly treeHashBefore: string;
}

type Fixtures = {
  scenario: string;
  crashAt: string | undefined;
  /** Adds `.env` with {@link FIXTURE_ENV_SECRET} to the project copy before hashing it. */
  projectEnvSecret: boolean;
  userDataDir: string;
  project: ProjectCopy;
  session: Session;
  app: ElectronApplication;
  page: Page;
  relaunch: (opts?: { crashAt?: string; scenario?: string }) => Promise<Page>;
  /** Closes the current app (used before scanning userData on disk). */
  closeApp: () => Promise<void>;
  stubDialogs: (s: DialogStub) => Promise<void>;
  callLog: () => Promise<FakeCall[]>;
  perfMeasures: () => Promise<PerfMeasure[]>;
};

function launchEnv(o: LaunchOptions): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  // Claude/CI shells may export this; Electron would then run as plain Node and never open a window.
  delete env['ELECTRON_RUN_AS_NODE'];
  delete env['RELAY_CRASH_AT'];
  return {
    ...env,
    RELAY_E2E: '1',
    RELAY_PROVIDER_MODE: 'fake',
    RELAY_FAKE_SCENARIO: o.scenario,
    RELAY_USER_DATA_DIR: o.userDataDir,
    ...(o.crashAt === undefined ? {} : { RELAY_CRASH_AT: o.crashAt }),
  };
}

async function launch(o: LaunchOptions): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    executablePath: electronPath,
    args: [desktopDir], // Electron loads apps/desktop/package.json → main: out/main/index.js
    env: launchEnv(o),
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return { app, page };
}

/** On failure, attaches the main/runner logs from userData (traces and screenshots come from the config's `use`). */
async function attachLogs(userDataDir: string, testInfo: TestInfo): Promise<void> {
  if (testInfo.status === testInfo.expectedStatus) return;
  const logsDir = path.join(userDataDir, 'logs');
  let names: string[] = [];
  try {
    names = await readdir(logsDir);
  } catch {
    return;
  }
  for (const n of names) {
    const body = await readFile(path.join(logsDir, n)).catch(() => null);
    if (body !== null) await testInfo.attach(`log-${n}`, { body, contentType: 'text/plain' });
  }
}

async function treeHash(dir: string): Promise<string> {
  return (await computeFixtureManifest(dir)).treeHash;
}

export const test = base.extend<Fixtures>({
  scenario: ['happy-path', { option: true }],
  crashAt: [undefined, { option: true }],
  projectEnvSecret: [false, { option: true }],

  userDataDir: async ({}, use) => {
    const d = await makeTempDir();
    await use(d);
    // The host copies the bundled sample next to an overridden userData (`<userData>-samples`).
    await safeRemove(`${d}-samples`);
    if (process.env['RELAY_E2E_KEEP'] === '1') {
      // Retained for `pnpm check:secrets` (13 §M2), which reads this path as its default scan dir.
      await mkdir('test-results', { recursive: true });
      await writeFile('test-results/last-userdata.txt', `${d}\n`);
    } else {
      await safeRemove(d);
    }
  },

  // Every test gets its own copy of tests/fixtures/sample-api outside userData; the tree must be unchanged afterwards.
  project: [
    async ({ projectEnvSecret }, use) => {
      const parent = await makeTempDir('project-');
      const dir = path.join(parent, 'sample-api');
      await cp(SAMPLE_API_ROOT, dir, { recursive: true, verbatimSymlinks: true });
      if (projectEnvSecret) await writeFile(path.join(dir, '.env'), `${FIXTURE_ENV_SECRET}\n`);
      const before = await treeHash(dir);
      await use({ dir, name: 'sample-api', treeHashBefore: before });
      const after = await treeHash(dir);
      expect(after, 'the project files must be unchanged by every workflow (FR-10)').toBe(before);
      if (process.env['RELAY_E2E_KEEP'] !== '1') await safeRemove(parent);
    },
    { auto: true },
  ],

  session: async ({ userDataDir, scenario, crashAt }, use, testInfo) => {
    const s: Session = { ...(await launch({ userDataDir, scenario, crashAt })), launches: 1 };
    await use(s);
    await s.app.close().catch(() => undefined); // tolerate an already-crashed runner/app
    await attachLogs(userDataDir, testInfo);
  },

  app: async ({ session }, use) => {
    await use(session.app);
  },

  page: async ({ session }, use) => {
    await use(session.page);
  },

  relaunch: async ({ session, userDataDir, scenario }, use) => {
    await use(async (opts) => {
      // A clean quit lets the runner checkpoint; the next launch reuses the same profile.
      await session.app.close().catch(() => undefined);
      const next = await launch({ userDataDir, scenario: opts?.scenario ?? scenario, crashAt: opts?.crashAt });
      session.app = next.app;
      session.page = next.page;
      session.launches += 1;
      return next.page;
    });
  },

  closeApp: async ({ session }, use) => {
    await use(async () => {
      await session.app.close().catch(() => undefined);
    });
  },

  stubDialogs: async ({ session }, use) => {
    // Native dialogs are not intercepted by Playwright → stub in MAIN via the RELAY_E2E-only seam (08 §H3).
    await use(async (stub) => {
      await session.app.evaluate((_electron, s) => {
        const seam = (globalThis as { __relayDialogs?: { setStub(x: unknown): void } }).__relayDialogs;
        if (seam === undefined) throw new Error('__relayDialogs seam missing: is RELAY_E2E=1 honoured?');
        seam.setStub(s);
      }, stub);
    });
    await session.app
      .evaluate(() => {
        (globalThis as { __relayDialogs?: { clear(): void } }).__relayDialogs?.clear();
      })
      .catch(() => undefined);
  },

  callLog: async ({ userDataDir }, use) => {
    await use(async () => {
      let text: string;
      try {
        text = await readFile(path.join(userDataDir, 'fake-call-log.jsonl'), 'utf8');
      } catch {
        return [];
      }
      return text
        .split('\n')
        .filter((l) => l.trim() !== '')
        .map((l) => JSON.parse(l) as FakeLogEntry)
        .filter((e): e is FakeCall => e.kind !== 'reconcile');
    });
  },

  perfMeasures: async ({ session }, use) => {
    await use(async () =>
      session.page.evaluate(() =>
        performance
          .getEntriesByType('measure')
          .filter((m) => m.name.startsWith('relay:'))
          .map((m) => ({ name: m.name, duration: m.duration, startTime: m.startTime })),
      ),
    );
  },
});

export { expect };
