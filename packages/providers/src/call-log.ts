// 04 §D7 fake call log. The ONLY file in this package that touches the filesystem: it appends (synchronously, so a
// line survives an immediate process exit) and reads back its own JSONL log.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AttemptPurpose, ProviderId } from '@relay/contracts';

/** One fake `generate` call (12 §L6 / 11 read these to prove completed steps are not re-executed). */
export interface FakeCall {
  readonly at: number;
  readonly runId: string;
  readonly attemptId: string;
  readonly stepKey: string;
  readonly purpose: AttemptPurpose;
  readonly providerId: ProviderId;
  readonly modelId: string;
  readonly systemSha256: string;
}

/** Append-only call log; `append` is synchronous. */
export interface FakeCallLog {
  append(call: FakeCall): void;
  entries(): FakeCall[];
}

/** In-memory call log (unit tests, and the fake's default). */
export function createMemoryCallLog(): FakeCallLog {
  const calls: FakeCall[] = [];
  return {
    append: (call) => {
      calls.push({ ...call });
    },
    entries: () => calls.map((c) => ({ ...c })),
  };
}

/** JSONL call log: `appendFileSync` one JSON line per call; `entries()` re-reads the file (survives restarts). */
export function createJsonlCallLog(filePath: string): FakeCallLog {
  return {
    append: (call) => {
      mkdirSync(dirname(filePath), { recursive: true });
      appendFileSync(filePath, `${JSON.stringify(call)}\n`, 'utf8');
    },
    entries: () => {
      if (!existsSync(filePath)) return [];
      return readFileSync(filePath, 'utf8')
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as FakeCall);
    },
  };
}
