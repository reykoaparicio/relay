import type { ReactNode } from 'react';
import { Link, Navigate, useParams } from 'react-router';
import { PageHeader } from '../components/ui';
import { AboutSection, DiagnosticsSection } from '../features/settings/DiagnosticsSection';
import { DataSection } from '../features/settings/DataSection';
import { ProfilesSection } from '../features/settings/ProfilesSection';
import { ProjectsSection } from '../features/settings/ProjectsSection';
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
  profiles: () => <ProfilesSection />,
  projects: () => <ProjectsSection />,
  data: () => <DataSection />,
};

/** Settings (10 J10, lazy route): Providers (+ Models), Model profiles, Projects, Storage & data, Diagnostics, About. */
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
