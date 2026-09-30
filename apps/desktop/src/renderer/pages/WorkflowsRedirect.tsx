import { Navigate, useParams } from 'react-router';
import { Skeleton } from '../components/ui';
import { paths } from '../features/shell/paths';
import { useWorkflows } from '../hooks/useWorkflow';

/** `/p/:projectId/workflows` → the first workflow's editor (P0 ships one template). */
export function WorkflowsRedirect() {
  const { projectId = '' } = useParams();
  const workflows = useWorkflows();
  const first = workflows.data?.[0];
  if (first !== undefined) return <Navigate to={paths.workflow(projectId, first.id)} replace />;
  if (workflows.data !== undefined) return <Navigate to={paths.overview(projectId)} replace />;
  return (
    <div aria-busy="true">
      <Skeleton lines={3} />
    </div>
  );
}
