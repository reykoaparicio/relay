// Decision 1: an attempt whose outcome is uncertain (live classify, deadline/cancel abort after dispatch, an adapter
// throw, crash recovery `dispatching → unknown`, a mid-stream failure without final usage) is settled AT ONCE as an
// `estimated` charge — never parked in the `unknown` ledger bucket for a user decision. The estimate prices the input
// tokens of the attempt's recorded estimate (the provider count when one was obtained, else the local estimate) plus
// the output tokens observed so far (stream progress / partial usage; 0 if none) at the attempt's catalog prices,
// rounded up per category with `mulDivCeil` (contracts `computeCost`). A later reconciliation that learns the real
// usage appends a correction (`settle −estimate` + `settle +actual`), so the estimate is never counted twice.
import { computeCost, errors, isTerminalRunStatus, microusd, subMicrousd } from '@relay/contracts';
import type { AttemptId, EpochMs, Microusd, ModelPrices, RunId } from '@relay/contracts';
import type { AttemptRow, LedgerEntryInsert, LedgerEntryRow, Repos } from '@relay/storage';
import type { SettleAmount } from './budget.js';
import { logSafe } from './log-safe.js';
import type { EngineCtx } from './ports.js';
import { refreshReport } from './report.js';
import type { PostCommitEffect } from './run-machine.js';
import { appendRunEvent } from './run-machine.js';

/** What the estimate of an uncertain attempt is built from. */
export interface UncertainUsage {
  /** Input tokens of the attempt's estimate (provider count when obtained at estimate time, else local). */
  readonly inputTokens: number;
  /** Output tokens observed before the outcome became uncertain (0 if none). */
  readonly outputTokens: number;
}

/** The estimated charge: `input × input price + output × output price`, each rounded up (mulDivCeil). */
export function uncertainEstimate(u: UncertainUsage, prices: ModelPrices): Microusd {
  return computeCost({ uncachedInputTokens: u.inputTokens, cacheReadInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: u.outputTokens }, prices).microusd;
}

/** {@link uncertainEstimate} as a settlement amount (certainty `estimated`). */
export function uncertainCost(u: UncertainUsage, prices: ModelPrices): SettleAmount & { readonly kind: 'known' } {
  return { kind: 'known', microusd: uncertainEstimate(u, prices), certainty: 'estimated' };
}

const nonNegInt = (v: unknown): number => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : 0);

/** Input tokens recorded with the attempt at reservation (`estimate_json.inputTokens`; 0 when absent). */
export function recordedInputTokens(a: Pick<AttemptRow, 'estimate'>): number {
  const e = a.estimate;
  return typeof e === 'object' && e !== null ? nonNegInt((e as { inputTokens?: unknown }).inputTokens) : 0;
}

/**
 * Output tokens observed for an attempt from what was persisted: its (partial) usage and its `attempt.stream_progress`
 * events (the largest count wins). Used where the in-process progress is gone (crash recovery, legacy conversion).
 */
export function persistedOutputTokens(r: Repos, a: Pick<AttemptRow, 'id' | 'runId' | 'stepRunId' | 'usage'>): number {
  let out = nonNegInt(a.usage?.outputTokens);
  for (const e of r.events.listForStep(a.runId, a.stepRunId, [a.id])) {
    if (e.type !== 'attempt.stream_progress') continue;
    const p = e.payload as { attemptId?: unknown; outputTokensSoFar?: unknown };
    if (p.attemptId === a.id) out = Math.max(out, nonNegInt(p.outputTokensSoFar));
  }
  return out;
}

/** Whether a request may never have reached the provider: not sent / no response byte back, and nothing observed. */
export function mayNotHaveBeenCharged(i: {
  readonly phase: 'not_sent' | 'sent_no_response' | 'responded' | 'responded_partial' | null;
  readonly responseSeen: boolean;
  readonly outputTokens: number;
}): boolean {
  return (i.phase === 'not_sent' || i.phase === 'sent_no_response') && !i.responseSeen && i.outputTokens === 0;
}

/** Crash recovery / legacy: nothing proves a response arrived (no response id, no first byte, no output observed). */
export function persistedMayNotHaveBeenCharged(a: Pick<AttemptRow, 'providerResponseId' | 'firstByteAt'>, outputTokens: number): boolean {
  return a.providerResponseId === null && a.firstByteAt === null && outputTokens === 0;
}

/** The REQUEST_OUTCOME_UNKNOWN error recorded on an uncertain attempt (its estimate and the note in the details). */
export function uncertainError(attemptId: AttemptId, estimate: Microusd, mayNot: boolean) {
  return errors.requestOutcomeUnknown(attemptId, { details: { estimatedMicrousd: estimate, mayNotHaveBeenCharged: mayNot } });
}

/**
 * The attempt's charge date (§9.3 month window): when the request left (`dispatchedAt`), else when the attempt was
 * created. Crash recovery and the legacy conversion book an uncertain attempt's estimate there, never at the restart.
 */
export function chargeDateOf(a: Pick<AttemptRow, 'dispatchedAt' | 'createdAt'>): EpochMs {
  return a.dispatchedAt ?? a.createdAt;
}

/**
 * D1-1: the date a correction of `attemptId`'s estimate is booked at — the month its estimate lives in (the latest
 * positive `estimated` settle entry's date), so `settle −estimate` cancels it in the SAME month and `settle +X` lands in
 * the month the request was charged. Falls back to the attempt's charge date.
 */
export function correctionDateOf(entries: readonly LedgerEntryRow[], a: Pick<AttemptRow, 'id' | 'dispatchedAt' | 'createdAt'>): EpochMs {
  let at: EpochMs | null = null;
  let id = '';
  for (const e of entries) {
    if (e.attemptId !== a.id || e.bucket !== 'settled' || e.certainty !== 'estimated' || e.deltaMicrousd <= 0) continue;
    if (e.id > id) {
      id = e.id;
      at = e.createdAt;
    }
  }
  return at ?? chargeDateOf(a);
}

/** Per-certainty net settled amount of one attempt's ledger entries. */
export function settledByCertaintyOf(entries: readonly LedgerEntryRow[], attemptId: AttemptId): { estimated: number; total: number } {
  let estimated = 0;
  let total = 0;
  for (const e of entries) {
    if (e.attemptId !== attemptId || e.bucket !== 'settled') continue;
    total += e.deltaMicrousd;
    if (e.certainty === 'estimated') estimated += e.deltaMicrousd;
  }
  return { estimated, total };
}

/** Ledger refs of an attempt's movements. */
interface CorrectionRefs {
  readonly attemptId: AttemptId;
  readonly runId: RunId;
  readonly projectId: NonNullable<LedgerEntryInsert['projectId']>;
  readonly priceCatalogVersion: string;
  readonly createdAt: EpochMs;
}

/**
 * The correction group that replaces an attempt's estimated settlement by the real cost: `settle −estimate`
 * (certainty `estimated`) and `settle +X` (the new certainty). Net settled becomes X; the estimated part becomes 0, so
 * nothing is counted twice. Empty when nothing changes (same amount and certainty).
 */
export function correctionEntries(i: CorrectionRefs & { readonly estimate: Microusd; readonly X: Microusd; readonly certainty: 'reported' | 'calculated' | 'estimated' }): LedgerEntryInsert[] {
  if (i.certainty === 'estimated' && i.X === i.estimate) return [];
  const base = { scope: 'run' as const, attemptId: i.attemptId, runId: i.runId, projectId: i.projectId, priceCatalogVersion: i.priceCatalogVersion, createdAt: i.createdAt };
  return [
    { ...base, type: 'settle', bucket: 'settled', deltaMicrousd: subMicrousd(microusd(0), i.estimate), certainty: 'estimated', note: 'correction: estimate replaced' },
    { ...base, type: 'settle', bucket: 'settled', deltaMicrousd: i.X, certainty: i.certainty, note: 'correction: reconciled usage' },
  ];
}

/**
 * Start-time conversion of legacy data (decision 1): every open `unknown` liability is turned into an estimated
 * settlement by the same rule as a live uncertain outcome (`resolve_unknown −U` + `settle +estimate`, booked at the
 * charge date so it stays in its month), the attempt is marked uncertain (+ "may not have been charged"), and a
 * terminal run's report is refreshed. The setup scope's liability (no attempt, no token count) settles at its amount.
 * Idempotent (a converted liability is 0, so it is not listed again); logged. Returns the number of converted rows.
 */
export async function convertLegacyUnknowns(ctx: EngineCtx): Promise<number> {
  const open = ctx.db.repos.ledger.openUnknownLiabilities();
  if (open.length === 0) return 0;
  const fx: PostCommitEffect[] = [];
  const terminalRuns = new Set<RunId>();
  let converted = 0;
  let total = 0;
  ctx.db.tx('immediate', (r) => {
    const now = ctx.clock.now();
    for (const row of open) {
      const amount = convertOne(r, fx, row, now);
      if (amount === null) continue;
      converted += 1;
      total += amount.microusd;
      if (amount.runId !== null && isTerminalRunStatus(r.runs.get(amount.runId).status)) terminalRuns.add(amount.runId);
    }
  });
  for (const e of fx) if (e.kind === 'emit') ctx.emit(e.event);
  ctx.logger.info('recovery.unknown_converted', { liabilities: converted, estimatedMicrousd: total });
  for (const runId of terminalRuns) {
    const res = await refreshReport(ctx, runId).catch((e: unknown) => {
      ctx.logger.warn('recovery.unknown_report_failed', { runId, err: logSafe(e) });
      return null;
    });
    if (res !== null && !res.ok) ctx.logger.warn('recovery.unknown_report_failed', { runId, code: res.error.code });
  }
  return converted;
}

/** Converts one liability inside the caller's tx (re-read: another writer may have resolved it). */
function convertOne(r: Repos, fx: PostCommitEffect[], row: { readonly attemptId: AttemptId | null; readonly microusd: Microusd }, now: EpochMs): { microusd: Microusd; runId: RunId | null } | null {
  if (row.attemptId === null) {
    const U = r.ledger.setupBalances(0 as EpochMs, Number.MAX_SAFE_INTEGER as EpochMs).U;
    if (U <= 0) return null;
    r.ledger.append([
      { scope: 'setup', type: 'resolve_unknown', bucket: 'unknown', deltaMicrousd: subMicrousd(microusd(0), U), attemptId: null, runId: null, projectId: null, createdAt: now, note: 'converted to estimate' },
      { scope: 'setup', type: 'settle', bucket: 'settled', deltaMicrousd: U, certainty: 'estimated', attemptId: null, runId: null, projectId: null, createdAt: now, note: 'converted to estimate' },
    ]);
    return { microusd: U, runId: null };
  }
  const a = r.attempts.get(row.attemptId);
  const U = r.ledger.attemptBalances(a.id).unknown;
  if (U <= 0) return null;
  const out = persistedOutputTokens(r, a);
  const estimate = uncertainEstimate({ inputTokens: recordedInputTokens(a), outputTokens: out }, a.profileSnapshot.prices);
  const mayNot = persistedMayNotHaveBeenCharged(a, out);
  const run = r.runs.get(a.runId);
  const at = chargeDateOf(a); // the liability's month (§9.3 window), never moved to today
  const base = { scope: 'run' as const, attemptId: a.id, runId: a.runId, projectId: run.projectId, priceCatalogVersion: a.priceCatalogVersion, createdAt: at };
  r.ledger.append([
    { ...base, type: 'resolve_unknown', bucket: 'unknown', deltaMicrousd: subMicrousd(microusd(0), U), note: 'converted to estimate' },
    { ...base, type: 'settle', bucket: 'settled', deltaMicrousd: estimate, certainty: 'estimated', note: 'converted to estimate' },
  ]);
  r.attempts.markUncertain(a.id, mayNot);
  appendRunEvent(r, fx, a.runId, 'attempt.settled', { attemptId: a.id, stepRunId: a.stepRunId, converted: true, liability: U,
    cost: { kind: 'known', microusd: estimate, certainty: 'estimated' }, mayNotHaveBeenCharged: mayNot, at: now });
  return { microusd: estimate, runId: a.runId };
}
