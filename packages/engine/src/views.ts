// Read-side DTO mapping for the runner handlers (02 §B2 view DTOs). Never leaks `root_realpath`; money is µUSD.
import { contextManifestSchema, invariant, isTerminalRunStatus, stepOutputSchema } from '@relay/contracts';
import type {
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
import { SnapshotError, effectiveModelSteps } from './snapshot.js';

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
 * The certainty of one attempt's settled cost, from its own `settle` ledger entries (reported / calculated /
 * estimated; the weakest when mixed — e.g. `accept_estimated_charge` settles an unknown liability as `estimated`).
 * `unknown` when the attempt only has unknown-bucket entries; null when it has neither (nothing charged).
 */
export function attemptCostCertainty(entries: readonly LedgerEntryRow[], attemptId: AttemptRow['id']): CostCertainty | null {
  const own = entries.filter((e) => e.attemptId === attemptId);
  const weakest = weakestCertainty(own.filter((e) => e.bucket === 'settled').map(settledCertainty));
  if (weakest !== null) return weakest;
  return own.some((e) => e.bucket === 'unknown') ? 'unknown' : null;
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
  const liability = a.state === 'unknown' || a.state === 'abandoned';
  const cost = liability
    ? { microusd: unknown as Microusd, certainty: 'unknown' as const }
    : a.usage !== null || settled > 0
      ? { microusd: settled as Microusd, certainty: attemptCostCertainty(entries, a.id) ?? ('calculated' as const) }
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

/** RunDetail (inspector) with the server-computed actions. */
export function toRunDetail(r: Repos, p: InspectorProjection): RunDetail {
  const stepKeyOf = stepKeyLookup(p.steps);
  const unresolved = p.attempts.filter((a) => a.state === 'unknown');
  const latest = latestPerKey(p.steps);
  // The ledger is read once (one statement) when the run has attempts: their cost views (run-level Attempts tab, E1).
  const entries = p.attempts.length === 0 ? [] : r.ledger.listForRun(p.run.id).map((x) => x.entry);
  const modelOf = modelsOf(r, p.run);
  // Choose-profile options exist only for a paused run; none → choose_profile is not offered (E1 #8).
  const options = p.run.status === 'paused' ? profileOptionsOf(r, p.run, latest, p.attempts, true) : [];
  const facts = runActionFacts(latest, unresolved.length, isTerminalRunStatus(p.run.status) && r.artifacts.listForRun(p.run.id, ['patch']).length > 0,
    missingCredentialFact(r, p.run, latest), p.run);
  const availableActions = allowedRunActions(p.run, { ...facts, hasProfileOptions: options.length > 0 });
  return {
    ...toRunSummary({ ...p, stepProgress: stepProgressOf(latest) }),
    limits: p.run.limits,
    input: p.run.input,
    contextHash: p.run.contextHash,
    steps: p.steps.map((s) => toStepView(s, modelOf(s.stepKey))),
    pendingApproval: p.pendingApproval === null ? null : toApprovalView(p.pendingApproval),
    unresolvedAttempts: unresolved.map((a) => toAttemptView(a, stepKeyOf(a.stepRunId), entries)),
    executionMsUsed: p.run.executionMsUsed,
    revisionCycle: p.run.revisionCycle,
    statusDetail: p.run.statusDetail,
    reportArtifactId: p.reportArtifactId,
    availableActions,
    attempts: p.attempts.map((a) => toAttemptView(a, stepKeyOf(a.stepRunId), entries)),
    latestManifest: latestManifestOf(r, p.run, p.steps),
    profileOptions: availableActions.includes('choose_profile') ? options : [],
    stepMeta: stepMetaOf(r, p.run, latest),
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
