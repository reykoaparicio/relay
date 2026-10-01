// 13 §M4: the result-file format shared by scripts/evaluate.ts (writer) and scripts/evidence-table.ts (reader).
import type { RunStatus } from '@relay/contracts';

/** The two compared configurations (§17.3); the manual baseline is recorded by hand (docs/product/baseline-notes.md). */
export type EvalConfig = 'relay' | 'single-agent';

/** One `<config>/<task>-<n>.json` result (consumed by scripts/evidence-table.ts). */
export interface EvalResult {
  readonly schemaVersion: 1;
  readonly config: EvalConfig;
  readonly taskId: string;
  readonly repeat: number;
  readonly order: number;
  readonly runId: string | null;
  /** Final run status, or `not_started` when the cap stopped the evaluation before this run. */
  readonly status: RunStatus | 'not_started';
  readonly pauseReason: string | null;
  /** Why the harness stopped the run early (`cost_cap`, `paused:<reason>`, `timeout`, `harness_error`), else null. */
  readonly stopReason: string | null;
  readonly costs: { readonly settledReportedMicrousd: number; readonly settledCalculatedMicrousd: number; readonly settledEstimatedMicrousd: number; readonly unknownMicrousd: number };
  readonly elapsedMs: number;
  readonly startedAt: string;
  readonly steps: readonly { readonly stepKey: string; readonly state: string; readonly providerId: string | null; readonly modelId: string | null }[];
  readonly approvals: number;
  readonly artifacts: readonly string[];
}
