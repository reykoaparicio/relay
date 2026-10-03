// E1 (resilience): running segments measured on a MONOTONIC clock. `runs.running_since` is a wall-clock epoch; a Mac
// that sleeps mid-run (the wall clock jumps forward) or a clock set backwards would otherwise charge the sleep as
// execution time, or never reach the deadline. While this process holds a segment open it remembers the monotonic
// reading at its start; the open segment's length and the wall time it closes at are derived from it. Without a
// monotonic source (tests with a manual clock, a run left `running` by another process) the wall clock is used, as
// before. Keyed by run id (ULIDs are unique, so engines sharing a process never collide).
import { invariant } from '@relay/contracts';
import type { EpochMs, RunId } from '@relay/contracts';
import type { RunRow } from '@relay/storage';

/** Monotonic milliseconds: never jumps with wall-clock changes (on macOS it does not advance while the Mac sleeps). */
export interface MonotonicClock {
  now(): number;
}

interface Segment {
  readonly wallStart: EpochMs;
  readonly monoStart: number;
  readonly mono: MonotonicClock;
}

const open = new Map<RunId, Segment>();

type SegmentRun = Pick<RunRow, 'runningSince'> & { readonly id?: RunId | undefined };

function segmentOf(run: SegmentRun): Segment | undefined {
  if (run.id === undefined || run.runningSince === null) return undefined;
  const s = open.get(run.id);
  return s?.wallStart === run.runningSince ? s : undefined;
}

/**
 * Remembers the monotonic start of the run's open segment (idempotent for the same segment). A segment opened
 * earlier than now on the wall clock (re-arm after a restart of the watcher) is back-dated by its wall age.
 */
export function openSegment(runId: RunId, runningSince: EpochMs, wallNow: EpochMs, mono: MonotonicClock): void {
  const cur = open.get(runId);
  if (cur?.wallStart === runningSince) return;
  open.set(runId, { wallStart: runningSince, monoStart: mono.now() - Math.max(0, wallNow - runningSince), mono });
}

/** Forgets the run's segment (it left `running`). */
export function closeSegment(runId: RunId): void {
  open.delete(runId);
}

/**
 * Length of the open running segment in WHOLE ms: monotonic when this process measures it (floored — a real monotonic
 * source such as `performance.now()` is fractional, and `execution_ms_used` / epoch columns are INTEGER), else
 * `max(0, now − running_since)`.
 */
export function openSegmentMs(run: SegmentRun, now: EpochMs): number {
  if (run.runningSince === null) return 0;
  const s = segmentOf(run);
  return s === undefined ? Math.max(0, now - run.runningSince) : Math.max(0, Math.floor(s.mono.now() - s.monoStart));
}

/**
 * The wall timestamp to close the segment at so that `leaveRunning` (`execution_ms_used += at − running_since`) adds
 * exactly the monotonic length: `running_since + monotonic elapsed` (never the sleep). `now` without a segment.
 */
export function segmentEndAt(run: SegmentRun, now: EpochMs): EpochMs {
  if (run.runningSince === null || segmentOf(run) === undefined) return now;
  const at = run.runningSince + openSegmentMs(run, now);
  invariant(Number.isSafeInteger(at), 'a running segment closes at an integer epoch ms');
  return at as EpochMs;
}
