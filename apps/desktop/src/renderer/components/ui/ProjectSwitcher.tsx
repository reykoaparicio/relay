import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Check, ChevronsUpDown, FolderGit2, Plus } from 'lucide-react';

export interface ProjectOption {
  readonly id: string;
  readonly name: string;
  /** Secondary line, e.g. the display path "~/code/sample-api". */
  readonly detail?: string;
}

export interface ProjectSwitcherProps {
  readonly projects: readonly ProjectOption[];
  readonly activeId: string | null;
  readonly onSelect: (id: string) => void;
  readonly onAddProject?: () => void;
}

/** Radix DropdownMenu; the active project is a checked radio item, so it is announced (09 I3). */
export function ProjectSwitcher({ projects, activeId, onSelect, onAddProject }: ProjectSwitcherProps) {
  const active = projects.find((p) => p.id === activeId);
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button type="button" className="project-switcher">
          <span className="stack" style={{ gap: 0 }}>
            <span className="eyebrow">Project</span>
            <span>{active ? active.name : 'No project selected'}</span>
          </span>
          <ChevronsUpDown aria-hidden="true" />
          <span className="sr-only">, switch project</span>
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="menu" sideOffset={6} align="start">
          <DropdownMenu.Label className="eyebrow" style={{ padding: '4px 12px' }}>
            Projects
          </DropdownMenu.Label>
          <DropdownMenu.RadioGroup value={activeId ?? ''} onValueChange={onSelect}>
            {projects.map((p) => (
              <DropdownMenu.RadioItem key={p.id} value={p.id} className="menu-item">
                <span className="check-slot">
                  <DropdownMenu.ItemIndicator>
                    <Check aria-hidden="true" />
                  </DropdownMenu.ItemIndicator>
                </span>
                <FolderGit2 aria-hidden="true" />
                <span className="stack" style={{ gap: 0 }}>
                  <span>{p.name}</span>
                  {p.detail === undefined ? null : <span className="subtle mono">{p.detail}</span>}
                </span>
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
          {onAddProject ? (
            <>
              <DropdownMenu.Separator style={{ height: 1, background: 'var(--color-divider)', margin: '4px 0' }} />
              <DropdownMenu.Item className="menu-item" onSelect={onAddProject}>
                <span className="check-slot" />
                <Plus aria-hidden="true" />
                Add project
              </DropdownMenu.Item>
            </>
          ) : null}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
