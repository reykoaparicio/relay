import { Link } from 'react-router';
import type { CapabilityWarning } from '@relay/contracts';
import type { ProfileUse } from '../../hooks/useWorkflow';
import { paths } from '../shell/paths';

/** Workflows (with version) that name a profile, as links when the project is known. */
export function UsageList({ usage, projectId }: { readonly usage: readonly ProfileUse[]; readonly projectId: string | undefined }) {
  return (
    <ul className="small" style={{ margin: 0, paddingLeft: 16 }} aria-label="Workflows using this profile">
      {usage.map((u) => {
        const label = `${u.name} (${u.version === 'draft' ? 'draft' : `v${String(u.version)}`})`;
        return (
          <li key={`${u.workflowId}:${String(u.version)}`}>
            {projectId === undefined ? label : <Link to={paths.workflow(projectId, u.workflowId)}>{label}</Link>}
          </li>
        );
      })}
    </ul>
  );
}

/** A profile's capability warnings as text (or "OK"). The engine decides them; nothing is re-checked here. */
export function WarningList({ warnings }: { readonly warnings: readonly CapabilityWarning[] }) {
  if (warnings.length === 0) return <span className="badge success">OK</span>;
  return (
    <ul className="small" style={{ margin: 0, paddingLeft: 16 }}>
      {warnings.map((w, i) => (
        <li key={`${w.code}:${String(i)}`}>
          {w.message} <code>{w.code}</code>
        </li>
      ))}
    </ul>
  );
}
