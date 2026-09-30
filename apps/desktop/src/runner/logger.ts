// Runner-side JSONL logger (08 H7 logging): logs/<YYYY-MM-DD>.jsonl, redacted, with 00b §3 fields. Main writes to the
// same daily file; O_APPEND keeps each line atomic across the two processes.
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { redactDeep } from '@relay/contracts';
import type { Logger } from '@relay/engine';

/** A redacting JSONL file logger implementing the engine's `Logger` port. */
export function createRunnerLogger(logsDir: string, now: () => number = Date.now): Logger {
  let ensured = false;
  const write = (level: string) => (event: string, fields?: Readonly<Record<string, unknown>>): void => {
    const ts = now();
    try {
      if (!ensured) {
        mkdirSync(logsDir, { recursive: true });
        ensured = true;
      }
      const line = JSON.stringify(redactDeep({ ts, level, event, proc: 'runner', ...fields }));
      appendFileSync(join(logsDir, `${new Date(ts).toISOString().slice(0, 10)}.jsonl`), `${line}\n`);
    } catch {
      // Logging never takes the runner down.
    }
  };
  return { debug: write('debug'), info: write('info'), warn: write('warn'), error: write('error') };
}
