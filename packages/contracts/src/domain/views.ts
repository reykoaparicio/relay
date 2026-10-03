import { z } from 'zod';
import { idSchema } from '../ids.js';
import { nonNegativeMicrousdSchema } from '../money.js';
import { findingsV1Schema } from '../outputs/findings.v1.js';
import { patchV1Schema } from '../outputs/patch.v1.js';
import { planV1Schema } from '../outputs/plan.v1.js';
import { reportV1Schema } from '../outputs/report.v1.js';
import { reviewV1Schema } from '../outputs/review.v1.js';
import { epochMsSchema, relPathSchema, sha256Schema, stepKeySchema } from '../primitives.js';
import { exclusionReasonSchema } from '../status.js';
import { attemptViewSchema } from './attempt.js';
import { runEventSchema } from './event.js';
import { contextManifestSchema } from './manifest.js';
import { runLimitsSchema } from './run.js';
import { stepViewSchema } from './step.js';

// Renderer-facing projections (02 §B2 "View DTOs"): no absolute paths, no secrets, money always Microusd.
// Entity-specific views live beside their entity (step.ts, attempt.ts, approval.ts, ledger.ts, …).

/** A validated step output, discriminated by schema id. */
export const stepOutputSchema = z.discriminatedUnion('schemaId', [
  z.object({ schemaId: z.literal('findings.v1'), value: findingsV1Schema }),
  z.object({ schemaId: z.literal('plan.v1'), value: planV1Schema }),
  z.object({ schemaId: z.literal('patch.v1'), value: patchV1Schema }),
  z.object({ schemaId: z.literal('review.v1'), value: reviewV1Schema }),
  z.object({ schemaId: z.literal('report.v1'), value: reportV1Schema }), // finalize step
]);
/** Step output. */
export type StepOutput = z.infer<typeof stepOutputSchema>;

/** `runs.getStep` output. */
export const stepDetailSchema = z.object({
  step: stepViewSchema,
  output: stepOutputSchema.nullable(),
  manifest: contextManifestSchema.nullable(), // latest attempt's manifest (B11)
  attempts: z.array(attemptViewSchema),
  events: z.array(runEventSchema), // events whose payload references this step
});
/** Step detail. */
export type StepDetail = z.infer<typeof stepDetailSchema>;

/** One included file of a preview. */
export const fileEntrySchema = z.object({
  relPath: relPathSchema,
  sizeBytes: z.number().int().nonnegative(),
  sha256: sha256Schema.nullable(),
  /**
   * E2 #11 (audit F1): the file's content looks like a credential. Shown, but NOT selected by default; a run may include
   * it only by listing it in the run input's `acknowledgedSuspectedSecrets`. Absent = no hit.
   */
  suspectedSecret: z.literal(true).optional(),
  /** What it looks like (`anthropic_key`, `openai_key`, `github_token`, `google_api_key`, `aws_access_key`, `private_key`, `bearer_token`, `credential_value`); never the value. */
  secretLabel: z.string().max(40).optional(),
  /** 1-based line of the first hit. */
  secretLine: z.number().int().positive().optional(),
});
/** File entry. */
export type FileEntry = z.infer<typeof fileEntrySchema>;

/** FR-01 / §3.4 file preview (excluded dirs collapse to one row). */
export const previewResultSchema = z.object({
  included: z.array(fileEntrySchema),
  excluded: z.array(z.object({ relPath: relPathSchema, reason: exclusionReasonSchema })),
  /** E2 #8: entries that exist but cannot be read (permissions); never selectable. Optional: older runners omit it. */
  unreadable: z.array(relPathSchema).optional(),
  totals: z.object({
    files: z.number().int(),
    bytes: z.number().int(),
    capBytes: z.number().int(),
    capFiles: z.number().int(),
  }),
});
/** Preview result. */
export type PreviewResult = z.infer<typeof previewResultSchema>;

/** App settings (Settings page; `app.getSettings` / `app.updateSettings`). */
export const appSettingsSchema = z.object({
  theme: z.enum(['system', 'light', 'dark']),
  activeProjectId: idSchema('project').nullable(),
  onboardingCompletedAt: epochMsSchema.nullable(),
  rawResponseRetentionDays: z.number().int().min(1).max(365), // default RAW_RESPONSE_RETENTION_DAYS
  setupAllowanceMicrousd: nonNegativeMicrousdSchema, // default SETUP_ALLOWANCE_MICROUSD
});
/** App settings. */
export type AppSettings = z.infer<typeof appSettingsSchema>;

/** `raise_limits` recovery decision: at least one limit, each within the {@link runLimitsSchema} bounds. */
const raiseLimitsDecisionSchema = z
  .object({
    kind: z.literal('raise_limits'),
    maxAttempts: runLimitsSchema.shape.maxAttempts.optional(),
    executionTimeoutSeconds: runLimitsSchema.shape.executionTimeoutSeconds.optional(),
  })
  .refine(
    (d) => d.maxAttempts !== undefined || d.executionTimeoutSeconds !== undefined,
    'raise at least one limit',
  );

/** `runs.resume` recovery decision (§12.5 "Run ID, recovery decision"). */
export const recoveryDecisionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('continue') }), // resume / review_recovery
  z.object({ kind: z.literal('use_preserved_snapshot') }),
  z.object({ kind: z.literal('resnapshot_and_replan') }),
  z.object({ kind: z.literal('switch_profile'), stepKey: stepKeySchema, profileId: idSchema('profile') }),
  raiseLimitsDecisionSchema,
  z.object({ kind: z.literal('acknowledge_overrun') }),
]);
/** Recovery decision. */
export type RecoveryDecision = z.infer<typeof recoveryDecisionSchema>;
