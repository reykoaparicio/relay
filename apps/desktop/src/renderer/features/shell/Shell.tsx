import { Suspense, useRef } from 'react';
import type { MouseEvent, ReactNode, RefObject } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, BookOpen, CircleCheck, LayoutDashboard, Settings, TriangleAlert, Workflow } from 'lucide-react';
import { Outlet, useMatches, useNavigate, useParams } from 'react-router';
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
} from '../../components/ui';
import type { NavItemData } from '../../components/ui';
import { call } from '../../api/client';
import { qk } from '../../api/keys';
import { useAppInfo } from '../../hooks/useAppInfo';
import { useProjects } from '../../hooks/useProjects';
import { useProviders } from '../../hooks/useProviders';
import { useSettings } from '../../hooks/useSettings';
import { useWorkflows } from '../../hooks/useWorkflow';
import { useRunnerState } from '../../state/PushSyncProvider';
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

/** "2 providers connected" / warning (§5.1). Status is text + icon, never color alone. */
function providerStatusText(providers: readonly ProviderStatus[]): { readonly text: string; readonly ok: boolean } {
  const connected = providers.filter((p) => p.connected);
  const healthy = connected.filter((p) => p.lastTest?.ok !== false);
  if (connected.length === 0) return { text: 'No providers connected', ok: false };
  if (healthy.length === connected.length) {
    return { text: `${String(healthy.length)} provider${healthy.length === 1 ? '' : 's'} connected`, ok: true };
  }
  return { text: `${String(healthy.length)} of ${String(connected.length)} providers connected`, ok: false };
}

function ProviderStatusLine() {
  const providers = useProviders();
  if (providers.data === undefined) return null;
  const { text, ok } = providerStatusText(providers.data);
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
  if (state === 'restarting') {
    return <InlineAlert tone="info" live="polite" title="Background runner restarting…">Runs continue from their last checkpoint when it is back.</InlineAlert>;
  }
  if (state === 'unavailable') {
    return (
      <InlineAlert
        tone="danger"
        live="polite"
        title="The background runner is unavailable"
        actions={
          <Button
            onClick={() => {
              void navigate(paths.settings('diagnostics'));
            }}
          >
            Open diagnostics
          </Button>
        }
      >
        Runs are paused safely. Relay could not restart the runner automatically.
      </InlineAlert>
    );
  }
  return null;
}

/** Count of runs waiting for approval (the Runs nav badge). */
function useAwaitingApprovalCount(projectId: string | undefined): number {
  const query = useQuery({
    queryKey: qk.runs(projectId ?? '', 'awaiting-count', 100),
    queryFn: () => call('relay/v1/runs.list', { projectId: projectId ?? '', status: ['awaiting_approval'], limit: 100 }),
    enabled: projectId !== undefined && projectId !== '',
  });
  return query.data?.items.length ?? 0;
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
  const awaiting = useAwaitingApprovalCount(projectId);
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
            badgeCount: awaiting,
            badgeLabel: (n) => `${String(n)} waiting for approval`,
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
          <ProviderStatusLine />
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
