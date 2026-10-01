// Route path builders (10 J1 table). `href()` converts a path for plain `<a href>` under the hash router.

/** Run inspector tabs (`?tab=`). */
export type InspectorTab = 'output' | 'context' | 'attempts' | 'events' | 'ledger';
/** Memory tabs (`?tab=`). */
export type MemoryTab = 'approved' | 'suggested' | 'archived';
/** Settings sections (`/settings/:section`). */
export type SettingsSection = 'providers' | 'profiles' | 'projects' | 'data' | 'diagnostics' | 'about';

function withQuery(path: string, query: Readonly<Record<string, string | undefined>>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined) params.set(k, v);
  const qs = params.toString();
  return qs === '' ? path : `${path}?${qs}`;
}

export const paths = {
  root: () => '/',
  onboarding: (step?: string) => (step === undefined ? '/onboarding' : `/onboarding/${step}`),
  overview: (projectId: string) => `/p/${projectId}`,
  workflows: (projectId: string) => `/p/${projectId}/workflows`,
  workflow: (projectId: string, workflowId: string) => `/p/${projectId}/workflows/${workflowId}`,
  runs: (projectId: string, status?: string) => withQuery(`/p/${projectId}/runs`, { status }),
  newRun: (projectId: string) => `/p/${projectId}/runs/new`,
  run: (projectId: string, runId: string, opts: { readonly step?: string; readonly tab?: InspectorTab } = {}) =>
    withQuery(`/p/${projectId}/runs/${runId}`, { step: opts.step, tab: opts.tab }),
  report: (projectId: string, runId: string) => `/p/${projectId}/runs/${runId}/report`,
  memory: (projectId: string, opts: { readonly tab?: MemoryTab; readonly record?: string } = {}) =>
    withQuery(`/p/${projectId}/memory`, { tab: opts.tab, record: opts.record }),
  /** `project`: the project the Projects / Data sections act on (`?project=`, read by `useSettingsProject`). */
  settings: (section?: SettingsSection, opts: { readonly project?: string | undefined } = {}) =>
    withQuery(section === undefined ? '/settings' : `/settings/${section}`, { project: opts.project }),
};

/** `<a href>` value for an app path under `createHashRouter`. */
export function href(path: string): string {
  return `#${path}`;
}
