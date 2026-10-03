// `<userData>/last-shutdown.json`: lets a launch tell a deliberate quit from a crash, so the renderer can word the
// "run interrupted" banner correctly. Each launch reads the previous marker, then writes `{ clean: false }` with its
// own start time; a completed quit (or relaunch) overwrites it with `{ clean: true }`. A crash leaves `clean: false`.
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { epochMs, lastShutdownSchema } from '@relay/contracts';
import type { LastShutdown } from '@relay/contracts';
import { replaceFileAtomic } from './safe-write.js';

/** Marker file name under userData. */
export const SHUTDOWN_MARKER_FILE = 'last-shutdown.json';

/** Parses a marker; null for anything unreadable (first launch, a truncated write, a hand-edited file). */
export function parseShutdownMarker(text: string | null): LastShutdown | null {
  if (text === null) return null;
  try {
    const r = lastShutdownSchema.safeParse(JSON.parse(text));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

/** Dependencies of {@link createShutdownMarker}. */
export interface ShutdownMarkerDeps {
  readonly userDataDir: string;
  readonly now: () => number;
  /** Resolves the file text, or null when it does not exist / cannot be read. */
  readonly readText?: (path: string) => Promise<string | null>;
  /** Atomically replaces the file. */
  readonly writeText?: (path: string, text: string) => Promise<void>;
}

/** The marker service. Never throws: a marker that cannot be written only loses the clean/crash distinction. */
export interface ShutdownMarker {
  /** How the previous session ended (valid after {@link recordLaunch}). */
  previous(): LastShutdown | null;
  /** Reads the previous marker, then records this launch as "not yet quit cleanly". */
  recordLaunch(): Promise<void>;
  /** Records a clean quit. `runActive`: the user confirmed quitting while a run was in flight. */
  recordCleanQuit(runActive: boolean): Promise<void>;
}

/** Creates the marker service. */
export function createShutdownMarker(d: ShutdownMarkerDeps): ShutdownMarker {
  const file = join(d.userDataDir, SHUTDOWN_MARKER_FILE);
  const readText = d.readText ?? ((p: string) => fsp.readFile(p, 'utf8').catch(() => null));
  const writeText = d.writeText ?? ((p: string, t: string) => replaceFileAtomic(p, t));
  let prev: LastShutdown | null = null;
  /**
   * Round-3 B3: the marker operations run one after another in CALL order (the launch's read + write is one step), so
   * a launch write that is still in flight can never land after — and overwrite — a clean quit.
   */
  let chain: Promise<void> = Promise.resolve();
  const serial = (step: () => Promise<void>): Promise<void> => {
    chain = chain.then(step).catch(() => undefined);
    return chain;
  };
  const write = async (m: LastShutdown): Promise<void> => {
    await writeText(file, `${JSON.stringify(m)}\n`).catch(() => undefined);
  };
  return {
    previous: () => prev,
    recordLaunch: () =>
      serial(async () => {
        prev = parseShutdownMarker(await readText(file).catch(() => null));
        await write({ clean: false, at: epochMs(d.now()), runActive: false });
      }),
    recordCleanQuit: (runActive) => serial(() => write({ clean: true, at: epochMs(d.now()), runActive })),
  };
}
