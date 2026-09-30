// Pure derivation of the Overview's mock state from real data (10 J5 "Overview" rows).
import type { ProjectDetail, ProviderId, ProviderStatus, RunDetail, RunSummary } from '@relay/contracts';
import { providerIdSchema } from '@relay/contracts';
import { isActiveRun } from '../runs/run-display';

/** Statuses the Overview watches for attention (one query). */
export const OVERVIEW_WATCHED_STATUSES = [
  'queued',
  'running',
  'awaiting_approval',
  'cancelling',
  'paused',
  'interrupted',
] as const;

export interface OverviewModel {
  /** `projects.get().stats.runs === 0`. */
  readonly empty: boolean;
  readonly activeCount: number;
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

export function deriveOverview(project: ProjectDetail, watched: readonly RunSummary[]): OverviewModel {
  const awaiting = watched.find((r) => r.status === 'awaiting_approval');
  const running = awaiting === undefined ? watched.find((r) => r.status === 'running' || r.status === 'queued') : undefined;
  const interrupted = watched.find(
    (r) => r.status === 'interrupted' || (r.status === 'paused' && r.pauseReason === 'unknown_outcome'),
  );
  const authPaused = watched.find((r) => r.status === 'paused' && r.pauseReason === 'auth_required');
  return {
    empty: project.stats.runs === 0,
    activeCount: watched.filter(isActiveRun).length,
    awaiting,
    running,
    interrupted,
    authPaused,
    focus: awaiting ?? running ?? interrupted ?? authPaused ?? watched[0],
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
