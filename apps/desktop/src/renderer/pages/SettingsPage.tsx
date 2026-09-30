import type { ReactNode } from 'react';
import { Link, Navigate, useParams } from 'react-router';
import { PageHeader } from '../components/ui';
import { AboutSection, DiagnosticsSection } from '../features/settings/DiagnosticsSection';
import { ComingSoonSection } from '../features/settings/ComingSoonSection';
import { ProvidersSection } from '../features/settings/ProvidersSection';
import { paths } from '../features/shell/paths';
import type { SettingsSection } from '../features/shell/paths';
import { useNavPerf } from '../hooks/useNavPerf';

const SECTIONS: ReadonlyArray<{ readonly key: SettingsSection; readonly label: string }> = [
  { key: 'providers', label: 'Providers' },
  { key: 'profiles', label: 'Model profiles' },
  { key: 'projects', label: 'Projects' },
  { key: 'data', label: 'Storage & data' },
  { key: 'diagnostics', label: 'Diagnostics' },
  { key: 'about', label: 'About' },
];

/** The design system styles `.tab[aria-selected]`; section links use `aria-current`, so mirror that look. */
const CURRENT_TAB_STYLE = { color: 'var(--color-text)', borderBottomColor: 'var(--color-accent)' } as const;

function isSection(v: string): v is SettingsSection {
  return SECTIONS.some((s) => s.key === v);
}

const CONTENT: Readonly<Record<SettingsSection, () => ReactNode>> = {
  providers: () => <ProvidersSection />,
  diagnostics: () => <DiagnosticsSection />,
  about: () => <AboutSection />,
  profiles: () => (
    <ComingSoonSection
      title="Model profiles"
      description="Editing Economy, Balanced and Capable profiles arrives in a later milestone. Until then, pick a profile per step when you start a run; the Providers section shows the capability check of each profile."
    />
  ),
  projects: () => (
    <ComingSoonSection
      title="Projects"
      description="Renaming projects, editing exclusions, allowed providers, the monthly allowance and the OpenAI response-storage option arrive in a later milestone."
    />
  ),
  data: () => (
    <ComingSoonSection
      title="Storage & data"
      description="Backups, project and ledger exports, raw-response retention, the setup allowance and purging project history arrive in a later milestone. Relay does not claim the full database is encrypted."
    />
  ),
};

/** Settings (10 J10, lazy route). M1 sections: Providers (+ Models), Diagnostics, About; the rest say "coming soon". */
export function SettingsPage() {
  const { section } = useParams();
  const current: SettingsSection | null =
    section === undefined ? 'providers' : isSection(section) ? section : null;
  useNavPerf('settings', current !== null);
  if (current === null) return <Navigate to={paths.settings('providers')} replace />;
  const label = SECTIONS.find((s) => s.key === current)?.label ?? '';
  return (
    <>
      <PageHeader title="Settings" breadcrumbs={[{ label: 'Settings' }, { label }]} />
      <nav aria-label="Settings sections">
        <ul className="tabs" style={{ listStyle: 'none', margin: 0, flexWrap: 'wrap' }}>
          {SECTIONS.map((s) => (
            <li key={s.key}>
              <Link
                className="tab no-underline"
                to={paths.settings(s.key)}
                aria-current={s.key === current ? 'page' : undefined}
                style={s.key === current ? CURRENT_TAB_STYLE : undefined}
              >
                {s.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      {CONTENT[current]()}
    </>
  );
}
