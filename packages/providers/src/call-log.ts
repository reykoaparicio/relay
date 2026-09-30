// 04 §D7 fake call log. The ONLY file in this package that touches the filesystem: it appends (synchronously, so a
// line survives an immediate process exit) and reads back its own JSONL log. `generate` and `reconcile` calls share
// the log, distinguished by `kind`.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AttemptPurpose, ProviderId } from '@relay/contracts';

/** One fake `generate` call (12 §L6 / 11 read these to prove completed steps are not re-executed). */
export interface FakeCall {
  readonly kind: 'generate';
  readonly at: number;
  readonly runId: string;
  readonly attemptId: string;
  readonly stepKey: string;
  readonly purpose: AttemptPurpose;
  readonly providerId: ProviderId;
  readonly modelId: string;
  readonly systemSha256: string;
  /** Index of the scenario step that served the call, `null` when it fell through (reconcile re-uses it after a restart). */
  readonly scriptStep: number | null;
}

/** One fake `reconcile` call. Reconcile answer sequences continue from these after a restart. */
export interface FakeReconcileCall {
  readonly kind: 'reconcile';
  readonly at: number;
  readonly attemptId: string;
  readonly providerId: ProviderId;
}

/** Any line of the fake call log. */
export type FakeLogEntry = FakeCall | FakeReconcileCall;

/** Append-only call log; `append` is synchronous. */
export interface FakeCallLog {
  append(entry: FakeLogEntry): void;
  /** `generate` calls only (a line without `kind`, from an older log, is a `generate` call). */
  entries(): FakeCall[];
  /** `reconcile` calls only. */
  reconcileEntries(): FakeReconcileCall[];
}

const isReconcile = (e: FakeLogEntry): e is FakeReconcileCall => e.kind === 'reconcile';
const asGenerate = (e: FakeLogEntry): FakeCall | undefined =>
  isReconcile(e) ? undefined : { ...e, kind: 'generate', scriptStep: e.scriptStep ?? null };

function views(all: () => FakeLogEntry[]): Pick<FakeCallLog, 'entries' | 'reconcileEntries'> {
  return {
    entries: () => all().flatMap((e) => asGenerate(e) ?? []),
    reconcileEntries: () => all().filter(isReconcile).map((e) => ({ ...e })),
  };
}

/** In-memory call log (unit tests, and the fake's default). */
export function createMemoryCallLog(): FakeCallLog {
  const lines: FakeLogEntry[] = [];
  return {
    append: (entry) => {
      lines.push({ ...entry });
    },
    ...views(() => lines),
  };
}

/** JSONL call log: `appendFileSync` one JSON line per call; reads re-read the file (survives restarts). */
export function createJsonlCallLog(filePath: string): FakeCallLog {
  const readAll = (): FakeLogEntry[] => {
    if (!existsSync(filePath)) return [];
    return readFileSync(filePath, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as FakeLogEntry);
  };
  return {
    append: (entry) => {
      mkdirSync(dirname(filePath), { recursive: true });
      appendFileSync(filePath, `${JSON.stringify(entry)}\n`, 'utf8');
    },
    ...views(readAll),
  };
}
