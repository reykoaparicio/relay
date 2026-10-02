import { Pencil, Trash2 } from 'lucide-react';
import type { ModelProfile, ProfileWithWarnings } from '@relay/contracts';
import { Button, TableScroll } from '../../components/ui';
import { PROVIDER_LABELS } from '../../lib/format';
import { WarningList } from './ProfileLists';

export interface ProfilesTableProps {
  readonly rows: readonly ProfileWithWarnings[];
  readonly onEdit: (profile: ModelProfile) => void;
  readonly onDelete: (profile: ModelProfile) => void;
}

/** The model profiles with the engine's capability warnings, and Edit / Delete per profile. */
export function ProfilesTable({ rows, onEdit, onDelete }: ProfilesTableProps) {
  return (
    <TableScroll label="Model profiles">
      <table className="table">
        <caption className="sr-only">Model profiles</caption>
        <thead>
          <tr>
            <th scope="col">Profile</th>
            <th scope="col">Provider</th>
            <th scope="col">Model</th>
            <th scope="col" className="num">
              Default max output
            </th>
            <th scope="col">Capability check</th>
            <th scope="col">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ profile, warnings }) => (
            <tr key={profile.id}>
              <th scope="row">{profile.name}</th>
              <td>{PROVIDER_LABELS[profile.providerId]}</td>
              <td className="mono nowrap">{profile.modelId}</td>
              <td className="num">{profile.params.maxOutputTokens.toLocaleString()}</td>
              <td>
                <WarningList warnings={warnings} />
              </td>
              <td>
                <span className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                  <Button
                    size="sm"
                    icon={Pencil}
                    aria-label={`Edit ${profile.name}`}
                    onClick={() => {
                      onEdit(profile);
                    }}
                  >
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={Trash2}
                    aria-label={`Delete ${profile.name}`}
                    onClick={() => {
                      onDelete(profile);
                    }}
                  >
                    Delete
                  </Button>
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableScroll>
  );
}
