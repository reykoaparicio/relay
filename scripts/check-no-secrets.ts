// `pnpm check:secrets [dir…]` (13 §M2): scans for plaintext secrets and prints `N findings` (exit 1 if > 0).
// Default targets: the retained e2e userData dir named in test-results/last-userdata.txt (written by 12 §L2 when
// RELAY_E2E_KEEP=1), plus apps/desktop/out and apps/desktop/dist. Findings show path + location + a redacted label.
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatFinding, scanPath, type SecretFinding } from './lib/secrets-scan.js';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const LAST_USERDATA_FILE = path.join(REPO_ROOT, 'test-results', 'last-userdata.txt');
const BUILD_DIRS = [path.join(REPO_ROOT, 'apps/desktop/out'), path.join(REPO_ROOT, 'apps/desktop/dist')];

async function exists(p: string): Promise<boolean> {
  return (await stat(p).catch(() => null)) !== null;
}

/** Explicit dirs must all exist; the default userData dir is required, build dirs are scanned when present. */
async function resolveTargets(args: readonly string[]): Promise<string[]> {
  if (args.length > 0) {
    const dirs = args.map((a) => path.resolve(a));
    for (const d of dirs) if (!(await exists(d))) throw new Error(`check:secrets: ${d} does not exist`);
    return dirs;
  }
  const recorded = await readFile(LAST_USERDATA_FILE, 'utf8').catch(() => null);
  if (recorded === null) {
    throw new Error(
      `check:secrets: no directory given and ${path.relative(REPO_ROOT, LAST_USERDATA_FILE)} is missing (run an e2e spec with RELAY_E2E_KEEP=1 first)`,
    );
  }
  const userData = recorded.trim();
  if (userData === '' || !(await exists(userData))) throw new Error(`check:secrets: recorded userData dir ${JSON.stringify(userData)} does not exist`);
  const builds: string[] = [];
  for (const d of BUILD_DIRS) {
    if (await exists(d)) builds.push(d);
    else console.log(`(not present, skipped) ${path.relative(REPO_ROOT, d)}`);
  }
  return [userData, ...builds];
}

async function main(args: readonly string[]): Promise<number> {
  const targets = await resolveTargets(args);
  const findings: SecretFinding[] = [];
  for (const t of targets) {
    const s = await scanPath(t);
    console.log(`scanned ${t}: ${String(s.filesScanned)} files, ${String(s.tablesScanned)} tables`);
    for (const v of s.skipped) console.log(`  (vendor binaries, skipped) ${v}`);
    findings.push(...s.findings);
  }
  for (const f of findings) console.log(formatFinding(f));
  console.log(`${String(findings.length)} findings`);
  return findings.length > 0 ? 1 : 0;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 2;
}
