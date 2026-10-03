// Read-side DTO mapping for the runner handlers (02 §B2 view DTOs). Never leaks `root_realpath`; money is µUSD.
import { contextManifestSchema, invariant, isTerminalRunStatus, stepOutputSchema } from '@relay/contracts';
import type {
  ArtifactId,
  AttemptView,
  ContextManifest,
  Balances,
  CostCertainty,
  CostSummary,
  LedgerEntryView,
  Microusd,
  ModelOutputSchemaId,
  ProviderId,
  RunDetail,
  RunSummary,
  StepKey,
  StepOutput,
  StepView,
} from '@relay/contracts';
import type {
  AttemptRow,
  InspectorProjection,
  LedgerEntryRow,
  LedgerEntryWithStep,
  Repos,
  RunCosts,
  RunRow,
  RunSummaryProjection,
  StepRow,
} from '@relay/storage';
import { toApprovalView } from './approvals.js';
import { remaining } from './budget.js';
import type { RunActionFacts } from './run-machine.js';
import { allowedRunActions } from './run-machine.js';
import { latestManifestOf, missingCredentialFact, profileOptionsOf, stepMetaOf } from './run-views.js';
import { SnapshotError, effectiveModelSteps, snapshotOf } from './snapshot.js';
import type { OutputArtifactKind, RunSnapshot } from './ports.js';

/**
 * True when any attempt settled more than it reserved (§9.5 "actual usage exceeds the estimate"). `overrun` in the cost
 * summary means this — or the run being over its allowance — not only `remaining < 0`.
 */
export function attemptsOverran(entries: readonly LedgerEntryRow[]): boolean {
  const reserved = new Map<string, number>();
  const settled = new Map<string, number>();
  for (const e of entries) {
    if (e.attemptId === null) continue;
    if (e.type === 'reserve') reserved.set(e.attemptId, (reserved.get(e.attemptId) ?? 0) + e.deltaMicrousd);
    else if (e.type === 'settle') settled.set(e.attemptId, (settled.get(e.attemptId) ?? 0) + e.deltaMicrousd);
  }
  for (const [attemptId, x] of settled) {
    const n = reserved.get(attemptId);
    if (n !== undefined && x > n) return true;
  }
  return false;
}

/** Cost summary from balances + settled-by-certainty (02 `costSummarySchema`). */
function costSummaryOf(
  b: Balances,
  settled: Readonly<Record<CostCertainty, Microusd>>,
  attemptOverran = false,
): CostSummary {
  const rem = remaining(b);
  return {
    allowance: b.L,
    settledReported: settled.reported,
    settledCalculated: settled.calculated,
    settledEstimated: settled.estimated,
    reserved: b.R,
    unknown: b.U,
    remaining: rem,
    overrun: rem < 0 || attemptOverran,
    hasEstimates: settled.estimated > 0,
  };
}

/** Cost summary of one run's {@link RunCosts} (`LedgerRepo.runCosts`, or a projection's aggregates). */
export function costSummaryOfRun(c: RunCosts): CostSummary {
  return costSummaryOf(c.balances, c.settledByCertainty, c.attemptsOverran);
}

/** Accumulates ledger entries into a cost summary (per step or per run). */
export function costOfEntries(entries: readonly LedgerEntryRow[]): CostSummary {
  let L = 0;
  let R = 0;
  let U = 0;
  const settled: Record<CostCertainty, number> = { reported: 0, calculated: 0, estimated: 0, unknown: 0 };
  for (const e of entries) {
    if (e.bucket === 'allowance') L += e.deltaMicrousd;
    else if (e.bucket === 'reserved') R += e.deltaMicrousd;
    else if (e.bucket === 'unknown') U += e.deltaMicrousd;
    else settled[e.certainty ?? 'calculated'] += e.deltaMicrousd;
  }
  const C = settled.reported + settled.calculated + settled.estimated + settled.unknown;
  const b = { L: L as Microusd, C: C as Microusd, R: R as Microusd, U: U as Microusd };
  return costSummaryOf(b, settled as Record<CostCertainty, Microusd>, attemptsOverran(entries));
}

/** Weakest first: a total mixing certainties is only as certain as its least certain part. */
const CERTAINTY_WEAKEST_FIRST: readonly CostCertainty[] = ['unknown', 'estimated', 'calculated', 'reported'];

/** The weakest of `certainties` (`unknown` < `estimated` < `calculated` < `reported`), or null when there is none. */
export function weakestCertainty(certainties: Iterable<CostCertainty>): CostCertainty | null {
  const seen = new Set(certainties);
  return CERTAINTY_WEAKEST_FIRST.find((c) => seen.has(c)) ?? null;
}

/** The certainty of a settled entry (a settle entry without one is `calculated`, FR-09). */
export const settledCertainty = (e: LedgerEntryRow): CostCertainty => e.certainty ?? 'calculated';

/** Groups ledger entries by attempt id (entries without an attempt are left out). */
export function entriesByAttempt(entries: readonly LedgerEntryRow[]): Map<string, LedgerEntryRow[]> {
  const out = new Map<string, LedgerEntryRow[]>();
  for (const e of entries) {
    if (e.attemptId === null) continue;
    const list = out.get(e.attemptId);
    if (list === undefined) out.set(e.attemptId, [e]);
    else list.push(e);
  }
  return out;
}

/** Groups ledger rows by their attempt's step key (rows without an attempt are left out), in row order. */
export function entriesByStep(rows: readonly LedgerEntryWithStep[]): Map<StepKey, LedgerEntryRow[]> {
  const out = new Map<StepKey, LedgerEntryRow[]>();
  for (const { entry, stepKey } of rows) {
    if (stepKey === null) continue;
    const list = out.get(stepKey);
    if (list === undefined) out.set(stepKey, [entry]);
    else list.push(entry);
  }
  return out;
}

/**
 * The certainties that still carry a settled amount: the NET per certainty (a decision-1 correction `settle −estimate`
 * + `settle +actual` leaves `estimated` at 0, so a corrected cost is no longer shown as an estimate). A certainty whose
 * entries net to 0 while others carry the amount is left out. D1-2: when everything nets to 0 (an estimate corrected to
 * $0), the certainty of the LATEST settle entry (insertion order: ids are monotonic) is the one that stands.
 */
export function netSettledCertainties(settled: readonly LedgerEntryRow[]): CostCertainty[] {
  const net = new Map<CostCertainty, number>();
  let latest: LedgerEntryRow | null = null;
  for (const e of settled) {
    net.set(settledCertainty(e), (net.get(settledCertainty(e)) ?? 0) + e.deltaMicrousd);
    if (latest === null || e.id > latest.id) latest = e;
  }
  const carrying = [...net].filter(([, v]) => v !== 0).map(([c]) => c);
  if (carrying.length > 0) return carrying;
  return latest === null ? [] : [settledCertainty(latest)];
}

/**
 * The certainty of one attempt's settled cost, from its own `settle` ledger entries (reported / calculated /
 * estimated; the weakest of those still carrying an amount, {@link netSettledCertainties}). `unknown` when the
 * attempt only has (legacy) unknown-bucket entries; null when it has neither (nothing charged).
 */
export function attemptCostCertainty(entries: readonly LedgerEntryRow[], attemptId: AttemptRow['id']): CostCertainty | null {
  const own = entries.filter((e) => e.attemptId === attemptId);
  const weakest = weakestCertainty(netSettledCertainties(own.filter((e) => e.bucket === 'settled')));
  if (weakest !== null) return weakest;
  return own.some((e) => e.bucket === 'unknown') ? 'unknown' : null;
}

/**
 * The current output artifact of `kind`: the newest latest-row step of that output kind that has one (a superseded or
 * rejected output — its step re-opened as a new row — is not current). Used by the report and the interim patch export.
 */
export function outputOfKind(snapshot: RunSnapshot, latest: readonly StepRow[], kind: OutputArtifactKind): ArtifactId | null {
  const rows = latest.filter((s) => {
    const snap = snapshot.steps[s.stepKey];
    return snap?.kind === 'model' && snap.outputKind === kind && s.outputArtifactId !== null;
  });
  return rows.at(-1)?.outputArtifactId ?? null;
}

/** model of every step key from the effective snapshot (null for non-model steps or a malformed snapshot). */
function modelsOf(r: Repos, run: Pick<RunRow, 'id' | 'snapshot'>): (stepKey: StepKey) => { providerId: ProviderId; modelId: string } | null {
  let steps: ReturnType<typeof effectiveModelSteps>;
  try {
    steps = effectiveModelSteps(r, run);
  } catch (e) {
    if (e instanceof SnapshotError) return () => null;
    throw e;
  }
  return (stepKey) => {
    const s = steps.get(stepKey);
    return s === undefined ? null : { providerId: s.profile.providerId, modelId: s.profile.modelId };
  };
}

/** One step row → StepView. */
function toStepView(s: StepRow, model: { providerId: ProviderId; modelId: string } | null): StepView {
  return {
    id: s.id,
    stepKey: s.stepKey,
    revisionIndex: s.revisionIndex,
    retryIndex: s.retryIndex,
    state: s.state,
    profileName: s.profileName,
    providerId: model?.providerId ?? null,
    modelId: model?.modelId ?? null,
    outcome: s.outcome,
    outputArtifactId: s.outputArtifactId,
    error: s.error,
  };
}

/** One step row → StepView with its effective model (`runs.getStep`; one snapshot parse, one revisions query). */
export function stepViewOf(r: Repos, run: Pick<RunRow, 'id' | 'snapshot'>, s: StepRow): StepView {
  return toStepView(s, modelsOf(r, run)(s.stepKey));
}

/**
 * One attempt → AttemptView. Cost from the ledger `entries` of the attempt (entries of other attempts are ignored, so
 * the run's entries can be passed as they are): its balances and the certainty of its settle entries.
 */
export function toAttemptView(a: AttemptRow, stepKey: StepKey, entries: readonly LedgerEntryRow[]): AttemptView {
  let settled = 0;
  let unknown = 0;
  for (const e of entries) {
    if (e.attemptId !== a.id) continue;
    if (e.bucket === 'settled') settled += e.deltaMicrousd;
    else if (e.bucket === 'unknown') unknown += e.deltaMicrousd;
  }
  // A legacy unknown liability (data from before decision 1, converted at engine start) is the only 'unknown' cost.
  const cost = unknown > 0
    ? { microusd: unknown as Microusd, certainty: 'unknown' as const }
    : a.usage !== null || settled > 0 || a.outcomeUncertain
      ? { microusd: settled as Microusd, certainty: attemptCostCertainty(entries, a.id) ?? (a.outcomeUncertain ? ('estimated' as const) : ('calculated' as const)) }
      : null;
  const providerLatencyMs = a.firstByteAt !== null && a.finishedAt !== null ? Math.max(0, a.finishedAt - a.firstByteAt) : null;
  return {
    id: a.id,
    stepRunId: a.stepRunId,
    stepKey,
    seq: a.seq,
    purpose: a.purpose,
    state: a.state,
    providerId: a.providerId,
    modelId: a.modelId,
    usage: a.usage,
    cost,
    providerLatencyMs,
    appElapsedMs: a.finishedAt === null ? null : Math.max(0, a.finishedAt - a.createdAt),
    providerRequestId: a.providerRequestId,
    startedAt: a.createdAt,
    finishedAt: a.finishedAt,
    mayNotHaveBeenCharged: a.mayNotHaveBeenCharged,
  };
}

/** The latest row per step key (max revision, then retry), ordered by ordinal. */
export function latestPerKey(steps: readonly StepRow[]): StepRow[] {
  const latest = new Map<string, StepRow>();
  for (const s of steps) {
    const cur = latest.get(s.stepKey);
    if (cur === undefined || s.revisionIndex > cur.revisionIndex || (s.revisionIndex === cur.revisionIndex && s.retryIndex > cur.retryIndex)) {
      latest.set(s.stepKey, s);
    }
  }
  return [...latest.values()].sort((a, b) => a.ordinal - b.ordinal);
}

/** `RunSummary.stepProgress` over the latest rows (= `RunRepo.listSummaries`' grouped progress). */
function stepProgressOf(latest: readonly StepRow[]): RunSummaryProjection['stepProgress'] {
  return { done: latest.filter((s) => s.state === 'succeeded' || s.state === 'skipped').length, total: latest.length };
}

/**
 * RunSummary (list row) from a summary projection (`RunRepo.listSummaries` / `summariesOf`, or an inspector
 * projection through {@link toRunDetail}). `cost.overrun` uses the one-statement `attemptsOverran` aggregate, so
 * `runs.list` and project-export summaries agree with `runs.get` (no ledger scan).
 */
export function toRunSummary(p: RunSummaryProjection): RunSummary {
  return {
    id: p.run.id,
    projectId: p.run.projectId,
    goal: p.run.goal,
    workflow: { id: p.workflow.id, version: p.workflow.version, name: p.workflow.name },
    status: p.run.status,
    pauseReason: p.run.pauseReason,
    stepProgress: p.stepProgress,
    cost: costSummaryOfRun(p),
    createdAt: p.run.createdAt,
    startedAt: p.run.startedAt,
    endedAt: p.run.endedAt,
  };
}

/** F2 `allowedRunActions` facts, shared by `RunDetail.availableActions` and the run-action gate (run-actions `offered`). */
export function runActionFacts(
  latest: readonly StepRow[],
  unknownAttempts: number,
  hasPatchArtifact: boolean,
  missingCredential = false,
  run?: Pick<RunRow, 'statusDetail'>,
): RunActionFacts {
  return { unknownAttempts, hasFailedStep: latest.some((s) => s.state === 'failed'), hasPatchArtifact, missingCredential,
    hasRetryableStep: latest.some((s) => s.state === 'failed' || s.state === 'unknown'),
    ...(run === undefined ? {} : { preservableSnapshot: run.statusDetail?.code === 'PROJECT_CHANGED' }) };
}

/** The step key of every step row id of a run. @throws invariant when an attempt's step row is not one of `steps` (FK). */
function stepKeyLookup(steps: readonly StepRow[]): (stepRunId: StepRow['id']) => StepKey {
  const keys = new Map(steps.map((s) => [s.id, s.stepKey]));
  return (id) => {
    const key = keys.get(id);
    invariant(key !== undefined, 'an attempt references a step row of its own run (FK)');
    return key;
  };
}

/** Whether `export_patch` has something to write: any patch of a finished run; the current patch of a run in progress. */
function hasExportablePatch(r: Repos, run: RunRow, latest: readonly StepRow[]): boolean {
  if (isTerminalRunStatus(run.status)) return r.artifacts.listForRun(run.id, ['patch']).length > 0;
  try {
    return outputOfKind(snapshotOf(run), latest, 'patch') !== null;
  } catch (e) {
    if (e instanceof SnapshotError) return false;
    throw e;
  }
}

/** RunDetail (inspector) with the server-computed actions. */
export function toRunDetail(r: Repos, p: InspectorProjection): RunDetail {
  const stepKeyOf = stepKeyLookup(p.steps);
  const latest = latestPerKey(p.steps);
  // The ledger is read once (one statement) when the run has attempts: their cost views (run-level Attempts tab, E1).
  const entries = p.attempts.length === 0 ? [] : r.ledger.listForRun(p.run.id).map((x) => x.entry);
  const views = new Map(p.attempts.map((a) => [a.id, toAttemptView(a, stepKeyOf(a.stepRunId), entries)]));
  const viewOf = (a: AttemptRow): AttemptView => views.get(a.id) ?? toAttemptView(a, stepKeyOf(a.stepRunId), entries);
  // Legacy: attempts still holding an unknown liability (none for data since decision 1).
  const unresolved = p.attempts.filter((a) => viewOf(a).cost?.certainty === 'unknown');
  // Decision 1: attempts settled as estimates because their outcome was uncertain, still estimated (not corrected).
  const uncertain = p.attempts.filter((a) => a.outcomeUncertain && viewOf(a).cost?.certainty === 'estimated');
  const modelOf = modelsOf(r, p.run);
  // Choose-profile options exist only for a paused run; none → choose_profile is not offered (E1 #8).
  const options = p.run.status === 'paused' ? profileOptionsOf(r, p.run, latest, p.attempts, true) : [];
  // Decision 2: export_patch whenever a patch can be exported, in every status (an interim export while in progress:
  // only the CURRENT patch, P-3 — a superseded/rejected one is not offered).
  const facts = runActionFacts(latest, unresolved.length, hasExportablePatch(r, p.run, latest),
    missingCredentialFact(r, p.run, latest), p.run);
  const availableActions = allowedRunActions(p.run, { ...facts, hasProfileOptions: options.length > 0 });
  return {
    ...toRunSummary({ ...p, stepProgress: stepProgressOf(latest) }),
    limits: p.run.limits,
    input: p.run.input,
    contextHash: p.run.contextHash,
    steps: p.steps.map((s) => toStepView(s, modelOf(s.stepKey))),
    pendingApproval: p.pendingApproval === null ? null : toApprovalView(p.pendingApproval),
    unresolvedAttempts: unresolved.map(viewOf),
    uncertainAttempts: uncertain.map(viewOf),
    executionMsUsed: p.run.executionMsUsed,
    revisionCycle: p.run.revisionCycle,
    statusDetail: p.run.statusDetail,
    reportArtifactId: p.reportArtifactId,
    availableActions,
    attempts: p.attempts.map(viewOf),
    latestManifest: latestManifestOf(r, p.run, p.steps),
    profileOptions: availableActions.includes('choose_profile') ? options : [],
    stepMeta: stepMetaOf(r, p.run, latest),
    // U-3: "Pausing…" until the requested pause is applied (cleared by USER_PAUSE / resume / a terminal status).
    pauseRequested: p.run.pauseRequested,
  };
}

/** Parses a stored artifact's JSON as a step output (null when absent or not a step output). */
export function toStepOutput(schemaId: string | null, value: unknown): StepOutput | null {
  if (schemaId === null) return null;
  const parsed = stepOutputSchema.safeParse({ schemaId: schemaId as ModelOutputSchemaId, value });
  return parsed.success ? parsed.data : null;
}

/** Parses a stored context manifest (null when invalid). */
export function toManifest(value: unknown): ContextManifest | null {
  const parsed = contextManifestSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** One ledger row → LedgerEntryView. */
export function toLedgerEntryView(e: LedgerEntryRow, stepKey: StepKey | null): LedgerEntryView {
  return {
    id: e.id,
    createdAt: e.createdAt,
    scope: e.scope,
    runId: e.runId,
    stepKey,
    attemptId: e.attemptId,
    type: e.type,
    bucket: e.bucket,
    deltaMicrousd: e.deltaMicrousd,
    certainty: e.certainty,
    priceCatalogVersion: e.priceCatalogVersion,
    note: e.note,
  };
}
