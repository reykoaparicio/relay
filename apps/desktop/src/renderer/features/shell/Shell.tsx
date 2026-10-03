import { Suspense, useEffect, useRef } from 'react';
import type { MouseEvent, ReactNode, RefObject } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, BookOpen, CircleCheck, LayoutDashboard, Settings, TriangleAlert, Workflow } from 'lucide-react';
import { Outlet, useLocation, useMatches, useNavigate, useParams } from 'react-router';
import type { ProviderStatus } from '@relay/contracts';
import {
  AppShell,
  Button,
  FakeProviderBadge,
  InlineAlert,
  ProjectSwitcher,
  SideNav,
  Skeleton,
  usePageFocusRescue,
  useToast,
} from '../../components/ui';
import type { NavItemData } from '../../components/ui';
import { call } from '../../api/client';
import { qk } from '../../api/keys';
import { useAppInfo } from '../../hooks/useAppInfo';
import { useDiagnostics } from '../../hooks/useDiagnostics';
import { useProjects } from '../../hooks/useProjects';
import { useProviders } from '../../hooks/useProviders';
import { useRun } from '../../hooks/useRun';
import { useSettings } from '../../hooks/useSettings';
import { useStatusChangedAt } from '../../hooks/useStatusChangedAt';
import { useWorkflows } from '../../hooks/useWorkflow';
import { useRunnerState } from '../../state/PushSyncProvider';
import { signInBlockedSince } from '../run-inspector/inspector-model';
import { RunnerFatalText, RunnerRecovery } from '../runner/RunnerRecovery';
import { href, paths } from './paths';

/** Nav key per leaf route id (`aria-current` on the matching item). */
const NAV_KEY_BY_ROUTE: Readonly<Record<string, string>> = {
  overview: 'overview',
  'workflow-editor': 'workflows',
  runs: 'runs',
  'new-run': 'runs',
  'run-inspector': 'runs',
  report: 'runs',
  memory: 'memory',
  settings: 'settings',
};

/**
 * "2 providers connected" / warning (§5.1). Status is text + icon, never color alone. A provider counts as unhealthy
 * while its last test failed, or while a run is paused for its sign-in (`signInNeeded`).
 */
export function providerStatusText(
  providers: readonly ProviderStatus[],
  signInNeeded: ReadonlySet<string> = new Set(),
): { readonly text: string; readonly ok: boolean } {
  const connected = providers.filter((p) => p.connected);
  const healthy = connected.filter((p) => p.lastTest?.ok !== false && !signInNeeded.has(p.providerId));
  if (connected.length === 0) return { text: 'No providers connected', ok: false };
  if (healthy.length === connected.length) {
    return { text: `${String(healthy.length)} provider${healthy.length === 1 ? '' : 's'} connected`, ok: true };
  }
  return { text: `${String(healthy.length)} of ${String(connected.length)} providers connected`, ok: false };
}

function ProviderStatusLine({ authPausedRunId }: { readonly authPausedRunId: string | undefined }) {
  const providers = useProviders();
  // A run paused for sign-in names its provider in the run detail (statusDetail.details.providerId). The provider is
  // unhealthy only while Resume cannot help yet — the inspector's rule: a successful reconnect/test since the pause
  // makes it healthy again, even though the run stays paused until the user resumes it.
  const authRun = useRun(authPausedRunId);
  const run = authRun.data;
  const pausedAt = useStatusChangedAt(run?.id, 'paused', run?.status === 'paused');
  const named = run?.statusDetail?.details?.['providerId'];
  // While the pause time is loading, a started run's provider stays unhealthy (a test from before the pause must not count).
  const blocked =
    run !== undefined && (run.startedAt !== null && pausedAt === undefined ? true : signInBlockedSince(run, providers.data, pausedAt ?? null) !== null);
  const signInNeeded = new Set(typeof named === 'string' && blocked ? [named] : []);
  if (providers.data === undefined) return null;
  const { text, ok } = providerStatusText(providers.data, signInNeeded);
  const Icon = ok ? CircleCheck : TriangleAlert;
  return (
    <a className={ok ? 'provider-status no-underline' : 'provider-status warn no-underline'} href={href(paths.settings('providers'))}>
      <Icon aria-hidden="true" />
      {text}
    </a>
  );
}

function RunnerBanner() {
  const state = useRunnerState();
  const navigate = useNavigate();
  // On Settings → Diagnostics itself, "Open diagnostics" would lead nowhere.
  const onDiagnostics = useLocation().pathname === paths.settings('diagnostics');
  const queryClient = useQueryClient();
  // Why it stopped (main keeps the last fatal): read only while the runner is unavailable.
  const diagnostics = useDiagnostics({ enabled: state === 'unavailable' });
  const previous = useRef(state);
  useEffect(() => {
    // Back from unavailable: refresh the fatal-free diagnostics (other queries refetch through their own errors).
    if (previous.current === 'unavailable' && state !== 'unavailable') void queryClient.invalidateQueries({ queryKey: qk.diagnostics() });
    previous.current = state;
  }, [state, queryClient]);
  if (state === 'restarting') {
    return <InlineAlert tone="info" live="polite" title="Background runner restarting…">Runs continue from their last checkpoint when it is back.</InlineAlert>;
  }
  if (state === 'unavailable') {
    const fatal = diagnostics.data?.runner.lastFatal;
    return (
      <InlineAlert
        tone="danger"
        live="polite"
        title="The background runner is unavailable"
      >
        <p>Runs are paused safely. Relay could not restart the runner automatically.</p>
        <RunnerFatalText fatal={fatal} />
        <RunnerRecovery
          fatal={fatal}
          compact
          extra={
            onDiagnostics ? undefined : (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  void navigate(paths.settings('diagnostics'));
                }}
              >
                Open diagnostics
              </Button>
            )
          }
        />
      </InlineAlert>
    );
  }
  return null;
}

/** Runs that wait for the user (the Runs nav badge): awaiting approval, and paused for any reason. */
function useAttentionCounts(projectId: string | undefined): {
  readonly awaiting: number;
  readonly paused: number;
  /** A run paused for provider sign-in, if any (the provider status line counts its provider as unhealthy). */
  readonly authPausedRunId: string | undefined;
} {
  const query = useQuery({
    queryKey: qk.runs(projectId ?? '', 'attention-count', 100),
    queryFn: () => call('relay/v1/runs.list', { projectId: projectId ?? '', status: ['awaiting_approval', 'paused'], limit: 100 }),
    enabled: projectId !== undefined && projectId !== '',
  });
  const items = query.data?.items ?? [];
  const awaiting = items.filter((r) => r.status === 'awaiting_approval').length;
  const authPausedRunId = items.find((r) => r.status === 'paused' && r.pauseReason === 'auth_required')?.id;
  return { awaiting, paused: items.length - awaiting, authPausedRunId };
}

/** Screen-reader text of the Runs badge, by what the runs wait for. */
export function attentionBadgeLabel(counts: { readonly awaiting: number; readonly paused: number }): string {
  const total = counts.awaiting + counts.paused;
  if (counts.paused === 0) return `${String(total)} waiting for approval`;
  if (counts.awaiting === 0) return `${String(total)} paused run${total === 1 ? ' needs' : 's need'} you`;
  return `${String(total)} runs need your attention`;
}

export interface ShellProps {
  readonly projectId: string | undefined;
  readonly activeRouteId: string | undefined;
  readonly children: ReactNode;
  readonly mainRef?: RefObject<HTMLElement | null>;
}

/** App frame (10 J4): AppShell + SideNav + ProjectSwitcher + provider status + FakeProviderBadge + runner banner. */
export function Shell({ projectId, activeRouteId, children, mainRef }: ShellProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const projects = useProjects();
  const info = useAppInfo();
  const workflows = useWorkflows();
  const attention = useAttentionCounts(projectId);
  const firstWorkflowId = workflows.data?.[0]?.id;

  const items: NavItemData[] =
    projectId === undefined
      ? [{ key: 'settings', label: 'Settings', href: href(paths.settings()), icon: Settings }]
      : [
          { key: 'overview', label: 'Overview', href: href(paths.overview(projectId)), icon: LayoutDashboard },
          {
            key: 'workflows',
            label: 'Workflows',
            href: href(firstWorkflowId === undefined ? paths.workflows(projectId) : paths.workflow(projectId, firstWorkflowId)),
            icon: Workflow,
          },
          {
            key: 'runs',
            label: 'Runs',
            href: href(paths.runs(projectId)),
            icon: Activity,
            badgeCount: attention.awaiting + attention.paused,
            badgeLabel: () => attentionBadgeLabel(attention),
          },
          { key: 'memory', label: 'Memory', href: href(paths.memory(projectId)), icon: BookOpen },
          { key: 'settings', label: 'Settings', href: href(paths.settings()), icon: Settings },
        ];

  const onNavigate = (key: string, event: MouseEvent<HTMLAnchorElement>) => {
    const item = items.find((i) => i.key === key);
    if (item === undefined || event.metaKey || event.ctrlKey || event.shiftKey) return;
    event.preventDefault();
    void navigate(item.href.slice(1));
  };

  const switchProject = (id: string) => {
    void navigate(paths.overview(id));
    void call('relay/v1/app.updateSettings', { activeProjectId: id }).then(() => queryClient.invalidateQueries({ queryKey: qk.settings() }));
  };

  return (
    <AppShell
      {...(mainRef === undefined ? {} : { mainRef })}
      brand={
        <>
          RELAY<small>Developer preview</small>
        </>
      }
      nav={<SideNav items={items} activeKey={activeRouteId === undefined ? null : (NAV_KEY_BY_ROUTE[activeRouteId] ?? null)} onNavigate={onNavigate} />}
      workspace={
        <>
          <span className="eyebrow">Local workspace</span>
          <ProjectSwitcher
            projects={(projects.data ?? []).map((p) => ({ id: p.id, name: p.name, detail: p.rootDisplayPath }))}
            activeId={projectId ?? null}
            onSelect={switchProject}
            onAddProject={() => {
              void navigate(paths.onboarding('select-project'));
            }}
          />
          <ProviderStatusLine authPausedRunId={attention.authPausedRunId} />
          {info.data?.providerMode === 'fake' ? <FakeProviderBadge /> : null}
        </>
      }
    >
      <RunnerBanner />
      {children}
    </AppShell>
  );
}

/**
 * Route element wrapping every page in the shell. The project comes from the URL (§5.1); routes without one
 * (settings, onboarding) fall back to the saved active project.
 */
export function ShellLayout() {
  const params = useParams();
  const matches = useMatches();
  const settings = useSettings();
  const projectId = params['projectId'] ?? settings.data?.activeProjectId ?? undefined;
  const activeRouteId = matches[matches.length - 1]?.id;
  // A11Y-02: when a mutation removes or disables the focused control, focus lands on <main>, never on <body>.
  const mainRef = useRef<HTMLElement>(null);
  usePageFocusRescue(mainRef);
  // Toasts belong to the page that raised them: leaving it dismisses them (search-param changes such as a tab or the
  // selected step stay on the page and keep them).
  const { pathname } = useLocation();
  const { dismissStale } = useToast();
  const lastPath = useRef(pathname);
  useEffect(() => {
    if (lastPath.current === pathname) return;
    lastPath.current = pathname;
    dismissStale();
  }, [pathname, dismissStale]);
  return (
    <Shell projectId={projectId} activeRouteId={activeRouteId} mainRef={mainRef}>
      <Suspense
        fallback={
          <div aria-busy="true">
            <Skeleton lines={4} height={18} />
          </div>
        }
      >
        <Outlet />
      </Suspense>
    </Shell>
  );
}
