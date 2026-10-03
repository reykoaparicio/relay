// Requests whose outcome Relay could not confirm (founder decision: never "unknown"). The engine counts each one as an
// estimated charge (`AttemptView.cost.certainty = 'estimated'`) and lists it in `RunDetail.uncertainAttempts`; older runs
// may still list one in `unresolvedAttempts`. Every view reads them through these helpers.
import type { AttemptView, RunDetail } from '@relay/contracts';

/** The run's requests that may or may not have completed (new `uncertainAttempts`, then legacy `unresolvedAttempts`). */
export function uncertainAttemptsOf(run: Pick<RunDetail, 'uncertainAttempts' | 'unresolvedAttempts'>): AttemptView[] {
  const out: AttemptView[] = [];
  const seen = new Set<string>();
  for (const a of [...run.uncertainAttempts, ...run.unresolvedAttempts]) {
    if (seen.has(a.id)) continue;
    seen.add(a.id);
    out.push(a);
  }
  return out;
}

/** The request may never have reached the provider: its estimate may not have been charged at all. */
export function mayNotHaveBeenCharged(a: Pick<AttemptView, 'mayNotHaveBeenCharged'>): boolean {
  return a.mayNotHaveBeenCharged;
}

/** The estimated amount Relay counted toward the budget for these requests (µUSD). */
export function uncertainAmount(attempts: readonly Pick<AttemptView, 'cost'>[]): number {
  return attempts.reduce((sum, a) => sum + (a.cost?.microusd ?? 0), 0);
}
