import { useId, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Archive } from 'lucide-react';
import { PROVIDER_IDS } from '@relay/contracts';
import type { InputOf, Microusd, Project, ProviderId } from '@relay/contracts';
import {
  Button,
  Checkbox,
  ConfirmDialog,
  ErrorView,
  Field,
  InlineAlert,
  MoneyInput,
  parseDollarInput,
  Skeleton,
  Textarea,
  TextInput,
  useToast,
} from '../../components/ui';
import { call } from '../../api/client';
import { toViewError, validationIssuesOf } from '../../api/errors';
import { qk } from '../../api/keys';
import { EXCLUSION_REASON_LABELS, PROVIDER_LABELS } from '../../lib/format';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';
import { usePreview } from '../../hooks/usePreview';
import { isStaleConflict } from '../common/conflict';
import { MutationError } from '../common/MutationError';
import { useRetryAction } from '../common/useNextAction';
import { dollarsText } from '../run-setup/limits';
import { formatBytes } from '../run-setup/PreviewPanel';
import { SettingsProjectPicker, useSettingsProject } from './useSettingsProject';

/** Providers a project may allow (the fake provider is a dev tool, never a policy choice). */
const POLICY_PROVIDERS = PROVIDER_IDS.filter((p): p is Exclude<ProviderId, 'fake'> => p !== 'fake');

/** Live exclusion preview delay (same cadence as the new-run preflight). */
export const EXCLUSION_PREVIEW_DEBOUNCE_MS = 400;

const FIELD = {
  name: 'project-field-name',
  exclusions: 'project-field-exclusions',
  providers: 'project-field-providers',
  allowance: 'project-field-allowance',
} as const;

function parseGlobs(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** Settings → Projects (10 J10): rename, exclusions with a live preview, provider policy, allowance, OpenAI store. */
export function ProjectsSection() {
  const { project, projects, choose } = useSettingsProject();
  const retry = useRetryAction(() => void projects.refetch());
  const titleId = useId();
  if (projects.error !== null) return <ErrorView error={toViewError(projects.error)} onAction={retry} />;
  if (projects.data === undefined) {
    return (
      <div className="card" aria-busy="true">
        <Skeleton lines={8} />
      </div>
    );
  }
  if (project === undefined) {
    return (
      <section className="card stack" aria-labelledby={titleId}>
        <h2 id={titleId}>Projects</h2>
        <p className="muted">No project yet. Create one from onboarding or try the sample project.</p>
      </section>
    );
  }
  return (
    <section className="stack" aria-label="Projects">
      <SettingsProjectPicker projects={projects.data} value={project.id} onChange={choose} />
      {/* Keyed by id only: a refetch (or a CONFLICT) must never remount the form and drop the user's edits. */}
      <ProjectForm key={project.id} project={project} />
    </section>
  );
}

/** The editable values of a project, as form text. */
interface ProjectValues {
  readonly name: string;
  readonly exclusionsText: string;
  /** Sorted provider ids. */
  readonly allowed: readonly ProviderId[];
  readonly allowanceText: string;
  readonly storeResponses: boolean;
}

type ProjectField = keyof ProjectValues;

const PROJECT_FIELD_LABELS: Readonly<Record<ProjectField, string>> = {
  name: 'Project name',
  exclusionsText: 'Exclusions',
  allowed: 'Allowed providers',
  allowanceText: 'Monthly allowance',
  storeResponses: 'Store responses at OpenAI',
};

const PROJECT_FIELDS = Object.keys(PROJECT_FIELD_LABELS) as ProjectField[];

function valuesOf(p: Project): ProjectValues {
  return {
    name: p.name,
    exclusionsText: p.exclusions.join('\n'),
    allowed: [...p.providerPolicy.allowedProviderIds].sort(),
    allowanceText: p.monthlyAllowanceMicrousd === null ? '' : dollarsText(p.monthlyAllowanceMicrousd),
    storeResponses: p.providerPolicy.providerOptions.openai.storeResponses,
  };
}

function sameValue(f: ProjectField, a: ProjectValues, b: ProjectValues): boolean {
  if (f === 'allowed') return sameList(a.allowed, b.allowed);
  if (f === 'exclusionsText') return sameList(parseGlobs(a.exclusionsText), parseGlobs(b.exclusionsText));
  if (f === 'name') return a.name.trim() === b.name.trim();
  return a[f] === b[f];
}

function valueText(f: ProjectField, v: ProjectValues): string {
  switch (f) {
    case 'allowed':
      return v.allowed.length === 0 ? 'None' : v.allowed.map((p) => PROVIDER_LABELS[p]).join(', ');
    case 'exclusionsText':
      return parseGlobs(v.exclusionsText).join(', ') || 'None';
    case 'allowanceText':
      return v.allowanceText.trim() === '' ? 'No monthly allowance' : `$${v.allowanceText}`;
    case 'storeResponses':
      return v.storeResponses ? 'On' : 'Off';
    case 'name':
      return v.name;
  }
}

/**
 * Project settings form. The project the user started editing is the *base*: the patch is the form diffed against it
 * and the save expects its `updatedAt`. A newer project (saved elsewhere, or loaded after a CONFLICT) never replaces
 * the user's edits: the form shows what changed on the server, and re-basing onto it is an explicit choice that keeps
 * the user's changes and takes every other field from the server.
 */
function ProjectForm({ project }: { readonly project: Project }) {
  const titleId = useId();
  const queryClient = useQueryClient();
  const toast = useToast();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [base, setBase] = useState(project);
  const [values, setValues] = useState<ProjectValues>(() => valuesOf(project));
  const [submitted, setSubmitted] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const { name, exclusionsText, allowanceText, storeResponses } = values;
  const allowed: ReadonlySet<ProviderId> = new Set(values.allowed);
  const set = (patch: Partial<ProjectValues>) => {
    setValues((v) => ({ ...v, ...patch }));
  };
  const parsedAllowance = parseDollarInput(allowanceText);
  const allowance: Microusd | null = parsedAllowance.ok ? parsedAllowance.value : null;

  const baseValues = valuesOf(base);
  const changedByMe = PROJECT_FIELDS.filter((f) => !sameValue(f, values, baseValues));
  // A newer project replaces an untouched form silently; with edits it is shown, never applied behind the user's back.
  // (Only a newer project: the list may still hold the pre-save project for a moment after a save.)
  if (project.updatedAt > base.updatedAt && changedByMe.length === 0) {
    setBase(project);
    setValues(valuesOf(project));
  }
  const serverAhead = project.updatedAt > base.updatedAt && changedByMe.length > 0;
  const serverValues = valuesOf(project);
  const changedOnServer = serverAhead ? PROJECT_FIELDS.filter((f) => !sameValue(f, serverValues, baseValues)) : [];
  const rebase = () => {
    const next: Record<string, unknown> = {};
    for (const f of PROJECT_FIELDS) next[f] = changedByMe.includes(f) ? values[f] : serverValues[f];
    setValues(next as unknown as ProjectValues);
    setBase(project);
  };

  const exclusions = parseGlobs(exclusionsText);
  // The runner previews saved exclusions + `extraExclusions`, so only the new patterns are sent (removals apply on save).
  const added = exclusions.filter((g) => !base.exclusions.includes(g));
  const removed = base.exclusions.filter((g) => !exclusions.includes(g));
  const settledAdded = useDebouncedValue(added.join('\n'), EXCLUSION_PREVIEW_DEBOUNCE_MS);
  const preview = usePreview({ projectId: project.id }, settledAdded === '' ? [] : settledAdded.split('\n'));
  const userExcluded = (preview.data?.excluded ?? []).filter((e) => e.reason === 'user_pattern');

  const allowanceInvalid = allowanceText.trim() !== '' && allowance === null;
  const local: Record<string, string> = {};
  if (name.trim() === '') local[FIELD.name] = 'Enter a project name.';
  else if (name.trim().length > 80) local[FIELD.name] = 'Use at most 80 characters.';
  if (exclusions.length > 100) local[FIELD.exclusions] = 'Use at most 100 patterns.';
  if (exclusions.some((g) => g.length > 200)) local[FIELD.exclusions] = 'Each pattern can be at most 200 characters.';
  if (allowed.size === 0) local[FIELD.providers] = 'Allow at least one provider, or no run can start.';
  if (allowanceInvalid) local[FIELD.allowance] = 'Enter an amount like 20.00, or leave it empty for no monthly allowance.';

  const changed = (f: ProjectField) => changedByMe.includes(f);
  const patch: InputOf<'relay/v1/projects.update'>['patch'] = {
    ...(changed('name') ? { name: name.trim() } : {}),
    ...(changed('exclusionsText') ? { exclusions } : {}),
    ...(changed('allowed') ? { allowedProviderIds: POLICY_PROVIDERS.filter((p) => allowed.has(p)) } : {}),
    ...(changed('allowanceText') && (allowanceText.trim() === '' || allowance !== null)
      ? { monthlyAllowanceMicrousd: allowanceText.trim() === '' ? null : allowance }
      : {}),
    ...(changed('storeResponses')
      ? { providerOptions: { ...base.providerPolicy.providerOptions, openai: { storeResponses } } }
      : {}),
  };
  const dirty = Object.keys(patch).length > 0;

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: qk.projects() });
    void queryClient.invalidateQueries({ queryKey: qk.project(project.id) });
    void queryClient.invalidateQueries({ queryKey: ['preview', project.id] });
  };
  const update = useMutation({
    // The expected `updatedAt` is the base the user edited, never a newer project loaded meanwhile.
    mutationFn: (input: { readonly expectedUpdatedAt: number; readonly patch: InputOf<'relay/v1/projects.update'>['patch'] }) =>
      call('relay/v1/projects.update', { projectId: project.id, expectedUpdatedAt: input.expectedUpdatedAt, patch: input.patch }),
    onSuccess: (p) => {
      setBase(p);
      // Edits typed while the save was in flight stay; every other field shows the saved value.
      setValues((v) => {
        const saved = valuesOf(p);
        return Object.fromEntries(PROJECT_FIELDS.map((f) => [f, sameValue(f, v, saved) ? saved[f] : v[f]])) as unknown as ProjectValues;
      });
      refresh();
      toast.show({ key: `project:saved:${p.id}`, title: `Saved “${p.name}”`, body: 'New runs use these settings.', tone: 'success' });
    },
    onError: (e) => {
      // Changed elsewhere: load the saved project so the form can show what changed (the edits stay).
      if (isStaleConflict(e)) refresh();
    },
  });
  const archive = useMutation({
    mutationFn: () => call('relay/v1/projects.archive', { projectId: project.id }),
    onSuccess: (p) => {
      setArchiveOpen(false);
      refresh();
      toast.show({ key: `project:archived:${p.id}`, title: `Archived “${p.name}”`, body: 'Its runs and memory stay on this computer.', tone: 'success' });
    },
  });
  const serverIssues = validationIssuesOf(update.error);
  const errorOf = (id: string) => (submitted ? local[id] : undefined);

  return (
    <section className="card stack" aria-labelledby={titleId}>
      <div className="card-header">
        <h2 id={titleId} ref={headingRef} tabIndex={-1}>
          {project.name}
        </h2>
        <span className="mono small muted">{project.rootDisplayPath}</span>
      </div>
      {project.archivedAt === null ? null : (
        <InlineAlert tone="info" title="This project is archived">
          <p>It is hidden from the project switcher. Its runs and memory are kept.</p>
        </InlineAlert>
      )}
      {serverAhead ? (
        <InlineAlert
          tone="warning"
          title="This project changed since you started editing"
          actions={
            <Button size="sm" variant="primary" onClick={rebase}>
              Keep my changes on top of the saved settings
            </Button>
          }
        >
          <p>Nothing was overwritten. Your edits are kept in the form; compare them with the saved settings:</p>
          <div className="table-wrap" style={{ overflowX: 'auto' }}>
            <table className="table">
              <caption className="sr-only">Saved project settings compared with your edits</caption>
              <thead>
                <tr>
                  <th scope="col">Setting</th>
                  <th scope="col">Saved now</th>
                  <th scope="col">Yours</th>
                </tr>
              </thead>
              <tbody>
                {[...new Set([...changedOnServer, ...changedByMe])].map((f) => (
                  <tr key={f}>
                    <th scope="row">
                      {PROJECT_FIELD_LABELS[f]}
                      {changedOnServer.includes(f) ? <span className="subtle">{' (changed on the server)'}</span> : null}
                    </th>
                    <td>{valueText(f, serverValues)}</td>
                    <td>{changedByMe.includes(f) ? valueText(f, values) : 'Unchanged'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="subtle">
            Keeping your changes sends only the settings you changed, based on the latest saved version; every other
            setting keeps the saved value.
          </p>
        </InlineAlert>
      ) : null}
      <form
        className="stack"
        noValidate
        aria-label="Project settings"
        onSubmit={(e) => {
          e.preventDefault();
          setSubmitted(true);
          if (Object.keys(local).length > 0 || !dirty || serverAhead) return;
          update.mutate({ expectedUpdatedAt: base.updatedAt, patch });
        }}
      >
        <Field label="Project name" id={FIELD.name} error={errorOf(FIELD.name)} required>
          {(control) => (
            <TextInput
              {...control}
              value={name}
              onValueChange={(v) => {
                set({ name: v });
              }}
            />
          )}
        </Field>
        <div className="grid grid-cols-2 gap-5 max-[1024px]:grid-cols-1">
          <Field
            label="Exclusions (one pattern per line)"
            id={FIELD.exclusions}
            hint="Added to Relay's defaults (dependencies, build output, secrets, binaries). Example: fixtures/** or *.snap"
            error={errorOf(FIELD.exclusions)}
          >
            {(control) => (
              <Textarea
                {...control}
                className="mono"
                rows={6}
                value={exclusionsText}
                onValueChange={(v) => {
                  set({ exclusionsText: v });
                }}
              />
            )}
          </Field>
          <section className="stack" aria-label="Exclusion preview" aria-live="polite" aria-busy={preview.isFetching || undefined}>
            <span className="section-label">Preview</span>
            {preview.error !== null ? (
              <MutationError error={preview.error} />
            ) : preview.data === undefined ? (
              <Skeleton lines={3} />
            ) : (
              <>
                <p className="small">
                  <span className="num">{String(preview.data.totals.files)}</span> files included ·{' '}
                  <span className="num">{formatBytes(preview.data.totals.bytes)}</span> of {formatBytes(preview.data.totals.capBytes)} input
                  cap · <span className="num">{String(userExcluded.length)}</span> excluded by your patterns
                </p>
                {userExcluded.length === 0 ? null : (
                  <ul className="small mono" style={{ margin: 0, paddingLeft: 16 }}>
                    {userExcluded.slice(0, 8).map((x) => (
                      <li key={x.relPath}>
                        {x.relPath} <span className="subtle">({EXCLUSION_REASON_LABELS[x.reason]})</span>
                      </li>
                    ))}
                    {userExcluded.length > 8 ? <li className="subtle">and {String(userExcluded.length - 8)} more</li> : null}
                  </ul>
                )}
                {removed.length === 0 ? null : (
                  <p className="small subtle">
                    Removed patterns ({removed.join(', ')}) take effect after you save.
                  </p>
                )}
              </>
            )}
          </section>
        </div>
        <fieldset className="fieldset field" aria-describedby={errorOf(FIELD.providers) === undefined ? `${FIELD.providers}-hint` : `${FIELD.providers}-hint ${FIELD.providers}-error`}>
          <legend>Providers allowed to receive selected context</legend>
          <div className="row" style={{ gap: 16, flexWrap: 'wrap' }}>
            {POLICY_PROVIDERS.map((p, i) => (
              <Checkbox
                key={p}
                {...(i === 0 ? { id: FIELD.providers } : {})}
                label={PROVIDER_LABELS[p]}
                checked={allowed.has(p)}
                onCheckedChange={(on) => {
                  const next = new Set(allowed);
                  if (on) next.add(p);
                  else next.delete(p);
                  set({ allowed: [...next].sort() });
                }}
              />
            ))}
          </div>
          <span className="hint" id={`${FIELD.providers}-hint`}>
            Selected context leaves this computer only through calls to providers this project allows. Local storage does
            not make remote processing private.
          </span>
          {errorOf(FIELD.providers) === undefined ? null : (
            <span className="error" id={`${FIELD.providers}-error`}>
              {errorOf(FIELD.providers)}
            </span>
          )}
        </fieldset>
        <MoneyInput
          id={FIELD.allowance}
          label="Monthly allowance (optional)"
          value={allowanceText}
          hint="Tracked by Relay across every run of this project in a calendar month. Empty means no monthly allowance. Changing it re-checks runs paused by the project allowance."
          onValueChange={(text) => {
            set({ allowanceText: text });
          }}
        />
        <div className="stack" style={{ gap: 4 }}>
          <Checkbox
            label="Store responses at OpenAI"
            checked={storeResponses}
            onCheckedChange={(on) => {
              set({ storeResponses: on });
            }}
          />
          <p className="hint small" style={{ margin: 0 }}>
            On by default. OpenAI keeps the response for a limited time, which lets Relay look up a request whose outcome
            is unknown (for example after a crash). When off, OpenAI does not store responses, and Relay cannot check an
            unknown outcome with OpenAI: you decide each one yourself.
          </p>
        </div>
        {serverIssues.length > 0 ? (
          <InlineAlert tone="danger" title="Relay could not save these settings">
            <ul className="small" style={{ margin: 0, paddingLeft: 16 }}>
              {serverIssues.map((i) => (
                <li key={`${i.path}:${i.message}`}>{i.message}</li>
              ))}
            </ul>
          </InlineAlert>
        ) : (
          <MutationError
            error={serverAhead && isStaleConflict(update.error) ? null : update.error}
            handlers={{ reload: refresh }}
            projectId={project.id}
          />
        )}
        {submitted && Object.keys(local).length > 0 ? (
          <p className="error small" role="alert">
            Fix the highlighted fields to save.
          </p>
        ) : null}
        <div className="actions">
          <Button type="submit" variant="primary" pending={update.isPending} disabled={!dirty || serverAhead}>
            Save project settings
          </Button>
          {project.archivedAt === null ? (
            <Button
              variant="ghost"
              icon={Archive}
              onClick={() => {
                archive.reset();
                setArchiveOpen(true);
              }}
            >
              Archive project…
            </Button>
          ) : null}
        </div>
      </form>
      {archiveOpen ? (
        <ConfirmDialog
          open
          onOpenChange={setArchiveOpen}
          title={`Archive “${project.name}”?`}
          returnFocusFallback={headingRef}
          consequences={
            <div className="stack">
              <p>
                The project is hidden from the project switcher and cannot start new runs. Its runs, reports, memory and
                usage ledger stay on this computer. Project files are never touched.
              </p>
              <p className="subtle">A project with an active run cannot be archived until that run ends.</p>
              <MutationError error={archive.error} projectId={project.id} />
            </div>
          }
          confirmLabel="Archive project"
          cancelLabel="Cancel"
          pending={archive.isPending}
          onConfirm={() => {
            archive.mutate();
          }}
        />
      ) : null}
    </section>
  );
}
