import { z } from 'zod';
import { INPUT_CAPS, MIN_EXECUTION_TIMEOUT_SECONDS, RUN_LIMIT_MAXIMUMS } from '../defaults.js';
import { appErrorSchema } from '../errors.js';
import { idSchema } from '../ids.js';
import { nonNegativeMicrousdSchema } from '../money.js';
import {
  epochMsSchema,
  idempotencyKeySchema,
  relPathSchema,
  sha256Schema,
  stepKeySchema,
} from '../primitives.js';
import { pauseReasonSchema, providerIdSchema, runActionSchema, runStatusSchema } from '../status.js';
import { approvalViewSchema } from './approval.js';
import { attemptViewSchema } from './attempt.js';
import { costSummarySchema } from './ledger.js';
import { stepViewSchema } from './step.js';

/** §9.1 run limits (bounded by `RUN_LIMIT_MAXIMUMS`). */
export const runLimitsSchema = z.object({
  budgetMicrousd: nonNegativeMicrousdSchema,
  maxRevisionCycles: z.number().int().min(0).max(RUN_LIMIT_MAXIMUMS.maxRevisionCycles),
  maxAttempts: z.number().int().min(1).max(RUN_LIMIT_MAXIMUMS.maxAttempts),
  maxConcurrentSteps: z.literal(1), // §9.1 P0
  executionTimeoutSeconds: z
    .number()
    .int()
    .min(MIN_EXECUTION_TIMEOUT_SECONDS)
    .max(RUN_LIMIT_MAXIMUMS.executionTimeoutSeconds),
  maxToolCalls: z.number().int().min(0).max(0), // ADR-014
});
/** Run limits. */
export type RunLimits = z.infer<typeof runLimitsSchema>;

/** Workflow default limits; missing fields fall back to `DEFAULT_LIMITS`. */
export const workflowLimitsSchema = runLimitsSchema.partial();
/** Workflow limits. */
export type WorkflowLimits = z.infer<typeof workflowLimitsSchema>;

/**
 * One acknowledgement of a suspected secret (E2 #11, round-3 M4): the selected file the user confirmed sending although
 * its content looks like it holds a secret, bound to the content the user saw — the sha256 of the file's bytes (the
 * `projects.previewFiles` / `previewRoot` `sha256` of a flagged file). Preflight, intake and a resnapshot honour it only
 * while the file's CURRENT content still has that hash; a changed file is flagged (`suspected_secret`) again.
 */
export const suspectedSecretAckSchema = z.object({ relPath: relPathSchema, sha256: sha256Schema });
/** Suspected-secret acknowledgement. */
export type SuspectedSecretAck = z.infer<typeof suspectedSecretAckSchema>;

/**
 * The `files` run input. `acknowledgedSuspectedSecrets`: selected files the user confirmed sending although their
 * content looks like it holds a secret (intake refuses such a file with PERMISSION_DENIED `suspected_secret` unless it
 * is listed here WITH its current content hash); every entry must be one of `relPaths`. Kept on the stored input, so
 * intake and a resnapshot see it on re-parse.
 */
const filesRunInputSchema = z
  .object({
    kind: z.literal('files'),
    relPaths: z.array(relPathSchema).min(1).max(INPUT_CAPS.maxFiles),
    acknowledgedSuspectedSecrets: z.array(suspectedSecretAckSchema).max(INPUT_CAPS.maxFiles).optional(),
  })
  .superRefine((v, ctx) => {
    const selected = new Set(v.relPaths);
    (v.acknowledgedSuspectedSecrets ?? []).forEach((a, i) => {
      if (!selected.has(a.relPath)) ctx.addIssue({ code: 'custom', path: ['acknowledgedSuspectedSecrets', i, 'relPath'], message: 'Not one of the selected files.' });
    });
  });

/** Run input: selected files, or an imported diff (imported as an artifact first, ADR-015). */
export const runInputSchema = z.discriminatedUnion('kind', [
  filesRunInputSchema,
  z.object({ kind: z.literal('diff'), diffArtifactId: idSchema('artifact') }),
]);
/** Run input. */
export type RunInput = z.infer<typeof runInputSchema>;

/**
 * Drops acknowledgements stored by an earlier build (round-3 M4), which were bare relPaths with no content hash. They
 * can never be matched against the file's current content, so they are treated as "not acknowledged": an old run
 * that re-reads its files (intake retry, resnapshot) flags such a file again (fail closed) instead of failing to load.
 */
function dropLegacyAcks(v: unknown): unknown {
  if (typeof v !== 'object' || v === null || (v as { kind?: unknown }).kind !== 'files') return v;
  const acks = (v as { acknowledgedSuspectedSecrets?: unknown }).acknowledgedSuspectedSecrets;
  if (!Array.isArray(acks) || !acks.some((a) => typeof a === 'string')) return v;
  const kept = acks.filter((a) => typeof a !== 'string');
  const rest: Record<string, unknown> = { ...(v as Record<string, unknown>) };
  delete rest['acknowledgedSuspectedSecrets'];
  return kept.length === 0 ? rest : { ...rest, acknowledgedSuspectedSecrets: kept };
}

/** A run input as stored in `runs.input_json` (storage re-parse): {@link runInputSchema}, legacy string acks dropped. */
export const storedRunInputSchema = z.preprocess(dropLegacyAcks, runInputSchema);

/**
 * `runs.start` input (§12.5). `memoryRecordIds` = approved records the user ticked; pinned user rules are always
 * included. `profileOverrides` = per-step profile for this run only.
 */
export const runStartInputSchema = z.object({
  idempotencyKey: idempotencyKeySchema,
  projectId: idSchema('project'),
  workflowId: idSchema('workflow'),
  workflowVersion: z.number().int().positive(),
  goal: z.string().min(1).max(2000),
  input: runInputSchema,
  limitOverrides: workflowLimitsSchema.optional(),
  profileOverrides: z.record(stepKeySchema, idSchema('profile')).optional(),
  memoryRecordIds: z.array(idSchema('memory')).max(50).optional(),
});
/** Run start input. */
export type RunStartInput = z.infer<typeof runStartInputSchema>;

/** Run list row. */
export const runSummarySchema = z.object({
  id: idSchema('run'),
  projectId: idSchema('project'),
  goal: z.string(),
  workflow: z.object({ id: idSchema('workflow'), version: z.number().int(), name: z.string() }),
  status: runStatusSchema,
  pauseReason: pauseReasonSchema.nullable(),
  stepProgress: z.object({ done: z.number().int(), total: z.number().int() }),
  cost: costSummarySchema,
  createdAt: epochMsSchema,
  startedAt: epochMsSchema.nullable(),
  endedAt: epochMsSchema.nullable(),
});
/** Run summary. */
export type RunSummary = z.infer<typeof runSummarySchema>;

/**
 * One profile the blocked step could switch to (`choose_profile`), with the reservation it would need: the local
 * estimate (no network) over the step's last estimated input tokens and the profile's catalog prices. `basis`:
 * `step_estimate` when the step's input was estimated before (a reserve-time block or an earlier attempt), else
 * `minimum` (input not estimated yet, e.g. a queued run blocked before intake: the smallest possible reservation —
 * word it "at least"). Only profiles whose provider the project allows and that have a credential ref are listed.
 * `current` marks the step's effective profile.
 */
export const profileOptionSchema = z.object({
  stepKey: stepKeySchema,
  profileId: idSchema('profile'),
  profileName: z.string(),
  providerId: providerIdSchema,
  modelId: z.string(),
  reservationMicrousd: nonNegativeMicrousdSchema,
  estimatedInputTokens: z.number().int().nonnegative(),
  basis: z.enum(['step_estimate', 'minimum']),
  current: z.boolean(),
});
/** Choose-profile option. */
export type ProfileOption = z.infer<typeof profileOptionSchema>;

/** Per step key: the optional display name from the workflow spec and the instruction version the run used. */
export const stepMetaSchema = z.object({
  stepKey: stepKeySchema,
  name: z.string().nullable(),
  instructionVersion: z.string().nullable(), // model steps only (e.g. "reviewer.v2")
});
/** Step meta. */
export type StepMeta = z.infer<typeof stepMetaSchema>;

/** The newest context manifest of the run (fetch the JSON with `artifacts.get`). */
export const manifestRefSchema = z.object({
  stepRunId: idSchema('stepRun'),
  stepKey: stepKeySchema,
  attemptId: idSchema('attempt'),
  artifactId: idSchema('artifact'),
});
/** Manifest ref. */
export type ManifestRef = z.infer<typeof manifestRefSchema>;

/** Run inspector projection. `availableActions` is server-computed (06 F2); the UI never re-derives rules. */
export const runDetailSchema = runSummarySchema.extend({
  limits: runLimitsSchema,
  input: runInputSchema,
  contextHash: sha256Schema.nullable(),
  steps: z.array(stepViewSchema),
  pendingApproval: approvalViewSchema.nullable(),
  unresolvedAttempts: z.array(attemptViewSchema), // unknown outcomes surfaced on relaunch (§4.4)
  executionMsUsed: z.number().int().nonnegative(), // §9.1 execution time (accrues only while running)
  revisionCycle: z.number().int(),
  statusDetail: appErrorSchema.nullable(), // the blocking error behind pauseReason
  reportArtifactId: idSchema('artifact').nullable(), // report.v1, set on every terminal transition (06 F17)
  availableActions: z.array(runActionSchema),
  // E1 additions (optional so older producers stay valid; the engine always sets them):
  /** Every attempt of the run, oldest first (the run-level Attempts tab). */
  attempts: z.array(attemptViewSchema).optional(),
  /** The newest context manifest of any attempt of the run (the run-level Context tab), or null. */
  latestManifest: manifestRefSchema.nullable().optional(),
  /** Choose-profile options with reservation estimates; non-empty only while `choose_profile` is offered. */
  profileOptions: z.array(profileOptionSchema).optional(),
  /** Display name and instruction version per step key, in step order. */
  stepMeta: z.array(stepMetaSchema).optional(),
});
/** Run detail. */
export type RunDetail = z.infer<typeof runDetailSchema>;
