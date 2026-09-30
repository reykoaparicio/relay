// Read-side DTO mapping for the runner handlers (02 §B2 view DTOs). Never leaks `root_realpath`; money is µUSD.
import { contextManifestSchema, isTerminalRunStatus, stepOutputSchema } from '@relay/contracts';
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
import type { AttemptRow, InspectorProjection, LedgerEntryRow, Repos, StepRow } from '@relay/storage';
import { toApprovalView } from './approvals.js';
import { remaining } from './budget.js';
import { allowedRunActions } from './run-machine.js';
import { SnapshotError, effectiveStepSnapshot } from './snapshot.js';

/** Cost summary from balances + settled-by-certainty (02 `costSummarySchema`). */
export function costSummaryOf(b: Balances, settled: Readonly<Record<CostCertainty, Microusd>>): CostSummary {
  const rem = remaining(b);
  return {
    allowance: b.L,
    settledReported: settled.reported,
    settledCalculated: settled.calculated,
    settledEstimated: settled.estimated,
    reserved: b.R,
    unknown: b.U,
    remaining: rem,
    overrun: rem < 0,
  };
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
  return costSummaryOf(b, settled as Record<CostCertainty, Microusd>);
}

/** Every ledger entry of a run (keyset pages, oldest first). */
export function allLedgerEntries(r: Repos, runId: RunDetail['id']): LedgerEntryRow[] {
  const out: LedgerEntryRow[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = r.ledger.list(runId, { limit: 100, sort: 'created_asc', cursor });
    if (!page.ok) return out;
    out.push(...page.value.items);
    if (page.value.nextCursor === null) return out;
    cursor = page.value.nextCursor;
  }
}

function modelInfo(r: Repos, p: InspectorProjection, stepKey: StepKey): { providerId: ProviderId; modelId: string } | null {
  try {
    const s = effectiveStepSnapshot(r, p.run, stepKey);
    return { providerId: s.profile.providerId, modelId: s.profile.modelId };
  } catch (e) {
    if (e instanceof SnapshotError) return null;
    throw e;
  }
}

/** One step row → StepView. */
export function toStepView(s: StepRow, model: { providerId: ProviderId; modelId: string } | null): StepView {
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

/** One attempt → AttemptView (cost from the attempt's ledger balances). */
export function toAttemptView(r: Repos, a: AttemptRow, stepKey: StepKey): AttemptView {
  const bal = r.ledger.attemptBalances(a.id);
  const liability = a.state === 'unknown' || a.state === 'abandoned';
  const cost = liability
    ? { microusd: bal.unknown, certainty: 'unknown' as const }
    : a.usage !== null || bal.settled > 0
      ? { microusd: bal.settled, certainty: 'calculated' as const }
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

/** RunSummary (list row) from an inspector projection. */
export function toRunSummary(p: InspectorProjection): RunSummary {
  const latest = latestPerKey(p.steps);
  return {
    id: p.run.id,
    projectId: p.run.projectId,
    goal: p.run.goal,
    workflow: { id: p.workflow.id, version: p.workflow.version, name: p.workflow.name },
    status: p.run.status,
    pauseReason: p.run.pauseReason,
    stepProgress: { done: latest.filter((s) => s.state === 'succeeded' || s.state === 'skipped').length, total: latest.length },
    cost: costSummaryOf(p.balances, p.settledByCertainty),
    createdAt: p.run.createdAt,
    startedAt: p.run.startedAt,
    endedAt: p.run.endedAt,
  };
}

function hasPatch(r: Repos, runId: RunDetail['id']): boolean {
  return r.artifacts.listForRun(runId, ['patch']).length > 0;
}

/** RunDetail (inspector) with the server-computed actions. */
export function toRunDetail(r: Repos, p: InspectorProjection): RunDetail {
  const stepKeyOf = new Map(p.steps.map((s) => [s.id, s.stepKey]));
  const unresolved = p.attempts.filter((a) => a.state === 'unknown');
  const latest = latestPerKey(p.steps);
  return {
    ...toRunSummary(p),
    limits: p.run.limits,
    input: p.run.input,
    contextHash: p.run.contextHash,
    steps: p.steps.map((s) => toStepView(s, modelInfo(r, p, s.stepKey))),
    pendingApproval: p.pendingApproval === null ? null : toApprovalView(p.pendingApproval),
    unresolvedAttempts: unresolved.map((a) => toAttemptView(r, a, stepKeyOf.get(a.stepRunId) ?? ('unknown' as StepKey))),
    executionMsUsed: p.run.executionMsUsed,
    revisionCycle: p.run.revisionCycle,
    statusDetail: p.run.statusDetail,
    reportArtifactId: p.reportArtifactId,
    availableActions: allowedRunActions(p.run, {
      unknownAttempts: unresolved.length,
      hasFailedStep: latest.some((s) => s.state === 'failed'),
      hasPatchArtifact: isTerminalRunStatus(p.run.status) && hasPatch(r, p.run.id),
    }),
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

/** attemptId → stepKey for a run. */
export function attemptStepKeys(r: Repos, runId: RunDetail['id']): Map<string, StepKey> {
  const steps = new Map(r.steps.listForRun(runId).map((s) => [s.id as string, s.stepKey]));
  return new Map(r.attempts.listForRun(runId).map((a) => [a.id as string, steps.get(a.stepRunId) ?? ('unknown' as StepKey)]));
}

/** Latest non-terminal-or-terminal output artifact of a step key, if any. */
export function latestOutputArtifact(steps: readonly StepRow[], stepKey: StepKey): ArtifactId | null {
  return latestPerKey(steps).find((s) => s.stepKey === stepKey)?.outputArtifactId ?? null;
}

