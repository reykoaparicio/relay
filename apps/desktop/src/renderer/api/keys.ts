// Query key factory (10 J2): primitive keys only, so there are no object-identity cache misses.
// Keys that share a prefix are invalidated together (`['runs', projectId]` covers every run list of a project).

/** Default page size of run lists (contracts PAGE_LIMITS.defaultLimit). */
export const RUNS_PAGE_SIZE = 25;

export const qk = {
  settings: () => ['settings'] as const,
  project: (id: string) => ['project', id] as const,
  projects: () => ['projects'] as const,
  projectCost: (projectId: string) => ['project-cost', projectId] as const,
  runs: (projectId: string, status?: string, limit: number = RUNS_PAGE_SIZE) =>
    ['runs', projectId, status ?? 'all', limit] as const,
  run: (id: string) => ['run', id] as const,
  step: (runId: string, stepId: string) => ['step', runId, stepId] as const,
  events: (runId: string) => ['events', runId] as const,
  ledger: (runId: string) => ['ledger', runId] as const,
  memory: (projectId: string, tab: string) => ['memory', projectId, tab] as const,
  memoryRecord: (id: string) => ['memory-record', id] as const,
  providers: () => ['providers'] as const,
  profiles: () => ['profiles'] as const,
  catalog: () => ['catalog'] as const,
  workflows: () => ['workflows'] as const,
  workflow: (id: string, v: number | 'draft') => ['workflow', id, v] as const,
  diagnostics: () => ['diagnostics'] as const,
  /** File preview of a directory selection or a project (`projects.previewFiles`). */
  preview: (target: string, extraExclusions: string = '') => ['preview', target, extraExclusions] as const,
  preflight: (fingerprint: string) => ['preflight', fingerprint] as const,
  info: () => ['app-info'] as const,
};
