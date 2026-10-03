import { Navigate } from 'react-router';
import { ErrorView, Skeleton } from '../components/ui';
import { toViewError } from '../api/errors';
import { paths } from '../features/shell/paths';
import { useProjects } from '../hooks/useProjects';
import { useSettings } from '../hooks/useSettings';

/** `/` → onboarding when there is no project or onboarding is incomplete, else the active project (10 J1). */
export function RootRedirect() {
  const settings = useSettings();
  const projects = useProjects();
  if (settings.error !== null || projects.error !== null) {
    return (
      <ErrorView
        error={toViewError(settings.error ?? projects.error)}
        onAction={() => {
          void settings.refetch();
          void projects.refetch();
        }}
        onRetry={() => {
          void settings.refetch();
          void projects.refetch();
        }}
      />
    );
  }
  if (settings.data === undefined || projects.data === undefined) {
    return (
      <div aria-busy="true">
        <Skeleton lines={3} />
      </div>
    );
  }
  const active = projects.data.find((p) => p.id === settings.data.activeProjectId) ?? projects.data[0];
  if (active === undefined || settings.data.onboardingCompletedAt === null) {
    return <Navigate to={paths.onboarding()} replace />;
  }
  return <Navigate to={paths.overview(active.id)} replace />;
}
