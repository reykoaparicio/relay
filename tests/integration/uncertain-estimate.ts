// Decision 1 integration helper: the estimate of an uncertain attempt computed independently of the engine — the
// input tokens recorded with the attempt's estimate plus the given output tokens, at the attempt's catalog prices.
import { computeCost } from '@relay/contracts';
import type { Db, AttemptRow } from '@relay/storage';
import type { RunId } from '@relay/contracts';

/** The expected estimate of `a` with `outputTokens` observed (default: its recorded usage's output, else 0). */
export function expectedEstimate(a: Pick<AttemptRow, 'estimate' | 'usage' | 'profileSnapshot'>, outputTokens = a.usage?.outputTokens ?? 0): number {
  const inputTokens = (a.estimate as { inputTokens?: number } | null)?.inputTokens ?? 0;
  return computeCost({ uncachedInputTokens: inputTokens, cacheReadInputTokens: 0, cacheWriteInputTokens: 0, outputTokens }, a.profileSnapshot.prices).microusd;
}

/** Ledger rows of one attempt as `[type, bucket, delta, certainty]`, oldest first. */
export function attemptEntries(db: Db, runId: RunId, attemptId: string): [string, string, number, string | null][] {
  return db.repos.ledger.listForRun(runId).map((x) => x.entry).filter((e) => e.attemptId === attemptId)
    .map((e) => [e.type, e.bucket, e.deltaMicrousd, e.certainty]);
}
