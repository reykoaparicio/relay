import * as RadixTabs from '@radix-ui/react-tabs';
import type { ReactNode } from 'react';

export interface Panel {
  readonly id: string;
  readonly label: ReactNode;
  readonly content: ReactNode;
}

export interface TabsProps {
  /** Accessible name of the tab list. */
  readonly label: string;
  readonly tabs: readonly Panel[];
  readonly value: string;
  readonly onValueChange: (id: string) => void;
}

/** Radix Tabs: roving tabindex, arrow keys, `aria-selected`, and tabpanel wiring (09 I3 `.tabs`). */
export function Tabs({ label, tabs, value, onValueChange }: TabsProps) {
  return (
    <RadixTabs.Root value={value} onValueChange={onValueChange} activationMode="automatic">
      <RadixTabs.List className="tabs" aria-label={label}>
        {tabs.map((t) => (
          <RadixTabs.Trigger key={t.id} value={t.id} className="tab">
            {t.label}
          </RadixTabs.Trigger>
        ))}
      </RadixTabs.List>
      {tabs.map((t) => (
        <RadixTabs.Content key={t.id} value={t.id} className="tab-panel">
          {t.content}
        </RadixTabs.Content>
      ))}
    </RadixTabs.Root>
  );
}
