// Pure derivation of the Overview's mock state from real data (10 J5 "Overview" rows).
import type { ProjectDetail, ProviderId, ProviderStatus, RunDetail, RunStatus, RunSummary } from '@relay/contracts';
import { providerIdSchema } from '@relay/contracts';
import { isActiveRun } from '../runs/run-display';

/** Statuses counted as "Active runs" (in progress, not paused or finished; `isActiveRun`). */
export const OVERVIEW_ACTIVE_STATUSES = ['queued', 'running', 'awaiting_approval', 'cancelling'] as const satisfies readonly RunStatus[];

/** Status-filtered heads the Overview derives from (each its own `runs.list` query, never a truncated mixed list). */
export interface OverviewRunHeads {
  /** `runs.list({ status: ['awaiting_approval'], limit: 1 })`. */
  readonly awaiting: readonly RunSummary[];
  /** `runs.list({ status: ['running', 'queued'], limit: 1 })`. */
  readonly running: readonly RunSummary[];
  /** `runs.list({ status: ['interrupted'], limit: 1 })`. */
  readonly interrupted: readonly RunSummary[];
  /** `runs.list({ status: ['paused'], limit: 100 })` (pause reasons are not filterable server-side). */
  readonly paused: readonly RunSummary[];
  /** `runs.list({ status: OVERVIEW_ACTIVE_STATUSES, limit: 100 })` and whether more exist (`nextCursor`). */
  readonly active: { readonly items: readonly RunSummary[]; readonly more: boolean };
}

export interface OverviewModel {
  /** `projects.get().stats.runs === 0`. */
  readonly empty: boolean;
  readonly activeCount: number;
  /** True when there are more active runs than one page shows ("100+"). */
  readonly activeCapped: boolean;
  /** Any run awaiting approval (attention card: the exact pending step). */
  readonly awaiting: RunSummary | undefined;
  /** A running run when no approval is pending. */
  readonly running: RunSummary | undefined;
  /** Any run `interrupted` or `paused(unknown_outcome)` (RecoveryPanel). */
  readonly interrupted: RunSummary | undefined;
  /** Runs paused for provider sign-in. */
  readonly authPaused: RunSummary | undefined;
  /** The run the attention card and run controls describe. */
  readonly focus: RunSummary | undefined;
}

export function deriveOverview(project: ProjectDetail, heads: OverviewRunHeads): OverviewModel {
  const awaiting = heads.awaiting[0];
  const running = awaiting === undefined ? heads.running[0] : undefined;
  const interrupted = heads.interrupted[0] ?? heads.paused.find((r) => r.pauseReason === 'unknown_outcome');
  const authPaused = heads.paused.find((r) => r.pauseReason === 'auth_required');
  const active = heads.active.items.filter(isActiveRun);
  return {
    empty: project.stats.runs === 0,
    activeCount: active.length,
    activeCapped: heads.active.more,
    awaiting,
    running,
    interrupted,
    authPaused,
    focus: awaiting ?? running ?? interrupted ?? authPaused ?? heads.paused[0] ?? active[0],
  };
}

/** A provider whose key was rejected (J5 provider-disconnected). */
export interface DisconnectedProvider {
  readonly providerId: ProviderId;
  readonly displayName: string;
  readonly redactedLabel: string | null;
}

/**
 * Providers needing reconnection: `lastTest.ok === false && code === 'AUTH_REQUIRED'`, plus the provider named by a
 * run paused `auth_required` (its `statusDetail.details.providerId`).
 */
export function disconnectedProviders(
  providers: readonly ProviderStatus[],
  authPausedRun: RunDetail | undefined,
): DisconnectedProvider[] {
  const out = new Map<ProviderId, DisconnectedProvider>();
  for (const p of providers) {
    if (p.lastTest?.ok === false && p.lastTest.code === 'AUTH_REQUIRED') {
      out.set(p.providerId, { providerId: p.providerId, displayName: p.displayName, redactedLabel: p.redactedLabel });
    }
  }
  const fromRun = providerIdSchema.safeParse(authPausedRun?.statusDetail?.details?.['providerId']);
  if (fromRun.success && !out.has(fromRun.data)) {
    const p = providers.find((x) => x.providerId === fromRun.data);
    out.set(fromRun.data, {
      providerId: fromRun.data,
      displayName: p?.displayName ?? fromRun.data,
      redactedLabel: p?.redactedLabel ?? null,
    });
  }
  return [...out.values()];
}
