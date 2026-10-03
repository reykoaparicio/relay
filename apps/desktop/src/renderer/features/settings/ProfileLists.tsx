import { Link } from 'react-router';
import type { CapabilityWarning, ProviderId } from '@relay/contracts';
import { PROVIDER_LABELS } from '../../lib/format';
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

/** A profile's capability warnings in plain words (or "OK"). The engine decides them; nothing is re-checked here. */
export function WarningList({ warnings, providerId }: { readonly warnings: readonly CapabilityWarning[]; readonly providerId?: ProviderId }) {
  if (warnings.length === 0) return <span className="badge success">OK</span>;
  const provider = providerId === undefined ? 'the provider' : PROVIDER_LABELS[providerId];
  return (
    <ul className="small" style={{ margin: 0, paddingLeft: 16 }}>
      {warnings.map((w, i) => (
        <li key={`${w.code}:${String(i)}`} title={w.code}>
          {w.code === 'missing_credential' ? (
            <>
              No API key is connected for {provider}.{' '}
              <Link to={paths.settings('providers')}>Connect {provider}</Link>
            </>
          ) : (
            w.message
          )}
        </li>
      ))}
    </ul>
  );
}
