import { useId } from 'react';
import { useSearchParams } from 'react-router';
import type { Project } from '@relay/contracts';
import { Field, Select } from '../../components/ui';
import { useProjects } from '../../hooks/useProjects';
import { useSettings } from '../../hooks/useSettings';

/**
 * The project the Projects and Data sections act on: `?project=<id>` when set, else the active project, else the
 * first project. Settings is not under `/p/:projectId`, so the choice lives in its own query parameter.
 */
export function useSettingsProject() {
  const [search, setSearch] = useSearchParams();
  const settings = useSettings();
  const projects = useProjects();
  const list = projects.data ?? [];
  const requested = search.get('project');
  const project: Project | undefined =
    list.find((p) => p.id === requested) ?? list.find((p) => p.id === settings.data?.activeProjectId) ?? list[0];
  const choose = (id: string) => {
    setSearch(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set('project', id);
        return next;
      },
      { replace: true },
    );
  };
  return { project, projects, settings, choose } as const;
}

/** Project picker shown when there is more than one project. */
export function SettingsProjectPicker({
  projects,
  value,
  onChange,
}: {
  readonly projects: readonly Project[];
  readonly value: string;
  readonly onChange: (id: string) => void;
}) {
  const id = useId();
  if (projects.length < 2) return null;
  return (
    <Field label="Project" id={id}>
      {(control) => (
        <Select
          {...control}
          value={value}
          onValueChange={onChange}
          options={projects.map((p) => ({ value: p.id, label: p.name }))}
          style={{ maxWidth: 320 }}
        />
      )}
    </Field>
  );
}
