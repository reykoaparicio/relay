// Fixed, honest text for the `limitations` section of report.v1 (07 G6 table; placed by the engine, 06 F17).

/**
 * Report limitation texts by key. The engine decides which apply:
 * `patch_not_applied`, `tests_not_run`, `cost_tracked` always; `model_checks_only` when a verify step ran;
 * `cost_estimated` when any cost entry is `estimated` or `unknown`; `run_incomplete` / `run_cancelled` /
 * `run_failed` by terminal status.
 */
export const REPORT_LIMITATIONS = {
  patch_not_applied:
    'Relay proposed a patch. It was not applied to your project, and your original files were not modified.',
  tests_not_run: 'Suggested tests were not run. Relay does not execute code.',
  model_checks_only: "The verifier's checks are model judgments against the plan and goal, not test results.",
  cost_tracked:
    "Costs are tracked by Relay from provider-reported usage and catalog prices. Your provider's invoice is authoritative.",
  cost_estimated: 'Some charges are estimates because the provider reported no usage.',
  run_incomplete: 'The run ended before the goal was met. Results below are partial.',
  run_cancelled: 'The run was cancelled. Only steps that finished are shown.',
  run_failed: 'The run stopped because of an internal error. Completed artifacts are intact.',
} as const;

/** A report limitation key. */
export type ReportLimitationKey = keyof typeof REPORT_LIMITATIONS;

/** The report limitation text table. */
export type ReportLimitations = Readonly<Record<ReportLimitationKey, string>>;
