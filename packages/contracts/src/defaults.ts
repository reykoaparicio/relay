// Policy constants (00b §2.4: no magic numbers). Each cites the spec section it encodes.

/** Default run limits (applied when neither the workflow nor the run overrides a field). */
export const DEFAULT_LIMITS = {
  budgetMicrousd: 3_000_000, // §9.1 illustrative $3.00
  maxRevisionCycles: 2, // §7.6
  maxAttempts: 10, // §12.4
  maxConcurrentSteps: 1, // §9.1
  executionTimeoutSeconds: 900, // §9.1 15 min (execution time only; approval waits don't count)
  maxToolCalls: 0, // ADR-014
} as const;

/** §7.6 P0 per-step retry defaults. */
export const RETRY_DEFAULTS_PER_STEP = { transport: 1, schemaRepair: 1, rateLimitWaits: 3 } as const;

/** §7.6 "within a maximum policy limit": the most a workflow may raise each retry counter. */
export const MAX_RETRY_POLICY = {
  transport: 2,
  schemaRepair: 2,
  rateLimitWaits: 5,
  qualityRevisions: 5,
} as const;

/** §7.6 "Backoff has a maximum wait". */
export const MAX_BACKOFF_MS = 60_000;

/** $0.05/month default allowance for providers.test (§3.3 budget check); editable in Settings. */
export const SETUP_ALLOWANCE_MICROUSD = 50_000;

/** §12.3 default raw-response retention; editable in Settings → Data. */
export const RAW_RESPONSE_RETENTION_DAYS = 30;

/** §9.1 upper bounds for user-raised run limits (`raise_limits`, `limitOverrides`). */
export const RUN_LIMIT_MAXIMUMS = {
  maxAttempts: 50,
  executionTimeoutSeconds: 7200,
  maxRevisionCycles: 5,
} as const;

/** §9.1 lower bound for a run's execution timeout. */
export const MIN_EXECUTION_TIMEOUT_SECONDS = 60;

/** §3.4 input caps. */
export const INPUT_CAPS = {
  maxFileBytes: 64 * 1024,
  maxTotalBytes: 512 * 1024,
  maxFiles: 200,
  maxDiffBytes: 1024 * 1024,
} as const;

/**
 * Default output allowance per role.
 * Deviation from the §9.1 example of 4,000: current models count thinking tokens against max output; too-low caps
 * truncate structured output (OUTPUT_INVALID). Admission still reserves the full cap, so spend remains bounded.
 */
export const DEFAULT_MAX_OUTPUT_TOKENS = {
  reviewer: 8_000,
  planner: 8_000,
  implementer: 16_000,
  verifier: 8_000,
} as const;

/** Hard ceiling for a profile's `maxOutputTokens` (02 §B2 `modelParamsSchema`). */
export const MAX_OUTPUT_TOKENS_CEILING = 128_000;

/** 02 §B0: idempotency keys are remembered for 24 h. */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

/** projects.pickDirectory selection token lifetime (02 §B5). */
export const SELECTION_TTL_MS = 10 * 60 * 1000;

/** 02 §B0 cursor pagination bounds. `runs.events` pages are larger (append-only, gapless backfill). */
export const PAGE_LIMITS = {
  defaultLimit: 25,
  maxLimit: 100,
  eventsDefaultLimit: 200,
  eventsMaxLimit: 500,
} as const;

/** `artifacts.get` default and maximum inline content size (02 §B5: ≤ 2 MiB). */
export const ARTIFACT_INLINE_MAX_BYTES = 2 * 1024 * 1024;

/** §5.5 / 07 G5 memory content limits. */
export const MEMORY_LIMITS = { titleMax: 120, contentMax: 4000, queryMax: 200 } as const;

/** 02 §B6 per-channel token buckets (enforced by the main router, 08 §H4). */
export const RATE_LIMITS = {
  /** providers.test: paid request (FR-02), 5 per minute. */
  paidTest: { capacity: 5, refillPerSec: 1 / 12 },
  /** providers.connect: brute-force / typo-loop protection. */
  credentialConnect: { capacity: 10, refillPerSec: 1 / 6 },
  /** runs.start / retryStep / resume: accidental repeat dispatch. */
  dispatch: { capacity: 10, refillPerSec: 1 / 2 },
  /** exports and backups: dialog spam. */
  dialog: { capacity: 5, refillPerSec: 1 / 5 },
  /** everything else: runaway render loops. */
  default: { capacity: 120, refillPerSec: 60 },
} as const;

/** B7 runner heartbeat interval. */
export const RUNNER_HEARTBEAT_MS = 2_000;
/** §6.4 lease staleness (not sufficient alone to take over). */
export const RUNNER_STALE_AFTER_MS = 10_000;
/** B7 maximum grace period for a runner shutdown request. */
export const RUNNER_SHUTDOWN_MAX_GRACE_MS = 10_000;

/** 02 §B5: `attempt.stream_progress` events are throttled to at most one per 500 ms (§5.7). */
export const STREAM_PROGRESS_THROTTLE_MS = 500;
