// FR-03 run snapshot (06 F15 / R3-13): parsing `runs.snapshot_json` and resolving the effective per-step config.
// The engine package has no direct zod dependency, so the snapshot is checked with the contracts schemas piecewise.
import {
  APPROVAL_BIND_TARGETS,
  idSchema,
  memoryScopeSchema,
  modelOutputSchemaIdSchema,
  profileSnapshotSchema,
  retryPolicySchema,
  roleSchema,
  sha256Schema,
  stepKeySchema,
} from '@relay/contracts';
import type { ModelOutputSchemaId, RunId, StepKey } from '@relay/contracts';
import type { Repos, RunRow } from '@relay/storage';
import type {
  ApprovalStepSnapshot,
  ModelStepSnapshot,
  OutputArtifactKind,
  RunSnapshot,
  StepSnapshot,
} from './ports.js';

/** Canonical output artifact kind for a model output schema. */
export function outputKindOf(schema: ModelOutputSchemaId): OutputArtifactKind {
  switch (schema) {
    case 'findings.v1':
      return 'findings';
    case 'plan.v1':
      return 'plan';
    case 'patch.v1':
      return 'patch';
    case 'review.v1':
      return 'review';
  }
}

/** Thrown when a stored snapshot is malformed (a bug or corruption, never user input). */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(`run snapshot invalid: ${message}`);
    this.name = 'SnapshotError';
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function parseDeps(v: unknown, key: string): StepKey[] {
  if (!Array.isArray(v)) throw new SnapshotError(`${key}.dependsOn`);
  return v.map((d) => {
    const r = stepKeySchema.safeParse(d);
    if (!r.success) throw new SnapshotError(`${key}.dependsOn`);
    return r.data;
  });
}

function parseModelStep(v: Record<string, unknown>, key: string): ModelStepSnapshot {
  const role = roleSchema.safeParse(v['role']);
  const profile = profileSnapshotSchema.safeParse(v['profile']);
  const schema = modelOutputSchemaIdSchema.safeParse(v['outputSchema']);
  const retry = retryPolicySchema.safeParse(v['retryPolicy']);
  const scope = memoryScopeSchema.safeParse(v['memoryScope']);
  const iv = v['instructionVersion'];
  const mot = v['maxOutputTokens'];
  if (!role.success || !profile.success || !schema.success || !retry.success || !scope.success) throw new SnapshotError(key);
  if (typeof iv !== 'string' || typeof mot !== 'number' || !Number.isInteger(mot) || mot <= 0) throw new SnapshotError(key);
  return {
    kind: 'model',
    role: role.data,
    profile: profile.data,
    outputSchema: schema.data,
    outputKind: outputKindOf(schema.data),
    instructionVersion: iv,
    maxOutputTokens: mot,
    retryPolicy: retry.data,
    memoryScope: scope.data,
    dependsOn: parseDeps(v['dependsOn'], key),
  };
}

function parseApprovalStep(v: Record<string, unknown>, key: string): ApprovalStepSnapshot {
  const bind = v['bindTo'];
  const targets: readonly string[] = APPROVAL_BIND_TARGETS;
  if (!Array.isArray(bind) || !bind.every((b) => typeof b === 'string' && targets.includes(b))) throw new SnapshotError(key);
  return { kind: 'approval', bindTo: bind as ApprovalStepSnapshot['bindTo'], dependsOn: parseDeps(v['dependsOn'], key) };
}

function parseStep(v: unknown, key: string): StepSnapshot {
  if (!isRecord(v)) throw new SnapshotError(key);
  switch (v['kind']) {
    case 'model':
      return parseModelStep(v, key);
    case 'approval':
      return parseApprovalStep(v, key);
    case 'intake':
    case 'finalize':
      return { kind: v['kind'], dependsOn: parseDeps(v['dependsOn'], key) };
    default:
      throw new SnapshotError(key);
  }
}

/**
 * Parses `runs.snapshot_json`.
 * @throws SnapshotError when the stored snapshot is malformed.
 */
export function parseRunSnapshot(raw: unknown): RunSnapshot {
  if (!isRecord(raw) || !isRecord(raw['steps'])) throw new SnapshotError('root');
  const steps: Record<string, StepSnapshot> = {};
  for (const [key, v] of Object.entries(raw['steps'])) steps[key] = parseStep(v, key);
  const hash = sha256Schema.safeParse(raw['workflowContentHash']);
  const ids = raw['memoryIncludeIds'];
  if (!hash.success || typeof raw['catalogVersion'] !== 'string' || !Array.isArray(ids)) throw new SnapshotError('meta');
  const memoryIncludeIds = ids.map((id) => {
    const r = idSchema('memory').safeParse(id);
    if (!r.success) throw new SnapshotError('memoryIncludeIds');
    return r.data;
  });
  return { steps, workflowContentHash: hash.data, catalogVersion: raw['catalogVersion'], memoryIncludeIds };
}

/** The run's snapshot (parsed). */
export function snapshotOf(run: Pick<RunRow, 'snapshot'>): RunSnapshot {
  return parseRunSnapshot(run.snapshot);
}

/** The snapshot of one step, or undefined. */
export function stepSnapshotOf(snapshot: RunSnapshot, stepKey: StepKey): StepSnapshot | undefined {
  return snapshot.steps[stepKey];
}

/**
 * R3-13: the model step's snapshot with the latest `run_config_revisions` profile applied (revision 0 otherwise).
 * @throws SnapshotError when `stepKey` is not a model step of the snapshot.
 */
export function effectiveStepSnapshot(r: Repos, run: Pick<RunRow, 'id' | 'snapshot'>, stepKey: StepKey): ModelStepSnapshot {
  const s = snapshotOf(run).steps[stepKey];
  if (s?.kind !== 'model') throw new SnapshotError(`${stepKey} is not a model step`);
  const revised = r.configRevisions.effectiveProfile(run.id, stepKey);
  return revised === null ? s : { ...s, profile: revised };
}

/** Every step key `stepKey` depends on, directly or transitively. */
export function ancestorsOf(snapshot: RunSnapshot, stepKey: StepKey): Set<StepKey> {
  const found = new Set<StepKey>();
  const stack: StepKey[] = [stepKey];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (cur === undefined) break;
    for (const dep of snapshot.steps[cur]?.dependsOn ?? []) {
      if (!found.has(dep)) {
        found.add(dep);
        stack.push(dep);
      }
    }
  }
  return found;
}

/** FR-08: a model step that depends (transitively) on an approval step is approval-bound (F6 #8). */
export function requiresApproval(snapshot: RunSnapshot, stepKey: StepKey): boolean {
  return [...ancestorsOf(snapshot, stepKey)].some((k) => snapshot.steps[k]?.kind === 'approval');
}

/** Model step keys of the snapshot, in insertion (ordinal) order. */
export function modelStepKeys(snapshot: RunSnapshot): StepKey[] {
  return Object.entries(snapshot.steps).flatMap(([k, s]) => (s.kind === 'model' ? [k as StepKey] : []));
}

/** Whether the user chose `use_preserved_snapshot` for this run (F6: read from its `run.snapshot_preserved` event). */
export function hasSnapshotPreserved(r: Repos, runId: RunId): boolean {
  return r.events.list(runId, 0, Number.MAX_SAFE_INTEGER).some((e) => e.type === 'run.snapshot_preserved');
}
