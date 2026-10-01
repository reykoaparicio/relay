// `pnpm check:project-untouched` (13 §M2): recomputes the sample-api fixture tree hash against its committed
// `.relay-fixture.json` (11 §K1) and fails on any drift. Reuses K's hashing (tests/helpers/fixture-hash.ts) at runtime
// so the algorithm has one definition; that file belongs to the `tests` TS project, hence the checked dynamic import.
import { fileURLToPath, pathToFileURL } from 'node:url';

const FIXTURE_HASH_MODULE = fileURLToPath(new URL('../tests/helpers/fixture-hash.ts', import.meta.url));

type CheckResult =
  | { readonly ok: true; readonly treeHash: string }
  | {
      readonly ok: false;
      readonly expectedTreeHash: string;
      readonly actualTreeHash: string;
      readonly added: readonly string[];
      readonly removed: readonly string[];
      readonly changed: readonly string[];
    };

type CheckFixtureTree = () => Promise<CheckResult>;

function isCheckFn(mod: unknown): mod is { checkFixtureTree: CheckFixtureTree; SAMPLE_API_ROOT: string } {
  if (typeof mod !== 'object' || mod === null) return false;
  return 'checkFixtureTree' in mod && typeof mod.checkFixtureTree === 'function' && 'SAMPLE_API_ROOT' in mod && typeof mod.SAMPLE_API_ROOT === 'string';
}

async function main(): Promise<number> {
  const mod: unknown = await import(pathToFileURL(FIXTURE_HASH_MODULE).href);
  if (!isCheckFn(mod)) throw new Error(`check:project-untouched: ${FIXTURE_HASH_MODULE} does not export checkFixtureTree`);
  const result = await mod.checkFixtureTree();
  if (result.ok) {
    console.log(`fixture ${mod.SAMPLE_API_ROOT}: treeHash ${result.treeHash}`);
    console.log('OK');
    return 0;
  }
  console.log(`fixture ${mod.SAMPLE_API_ROOT} differs from .relay-fixture.json`);
  console.log(`  expected treeHash ${result.expectedTreeHash}`);
  console.log(`  actual   treeHash ${result.actualTreeHash}`);
  for (const p of result.added) console.log(`  added    ${p}`);
  for (const p of result.removed) console.log(`  removed  ${p}`);
  for (const p of result.changed) console.log(`  changed  ${p}`);
  console.log('FAILED');
  return 1;
}

try {
  process.exitCode = await main();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 2;
}
