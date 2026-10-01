import { useEffect, useId, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CircleCheck, Lock, Save, ShieldCheck, Upload } from 'lucide-react';
import type {
  ProfileWithWarnings,
  WorkflowSummary,
  WorkflowValidationResult,
  WorkflowVersionView,
} from '@relay/contracts';
import {
  Button,
  ButtonLink,
  ErrorView,
  Hash,
  InlineAlert,
  PageHeader,
  Skeleton,
  useToast,
} from '../components/ui';
import { call } from '../api/client';
import { isNotImplemented, toViewError, validationIssuesOf } from '../api/errors';
import { qk } from '../api/keys';
import { ErrorSummary, focusField } from '../features/common/ErrorSummary';
import type { FormProblem } from '../features/common/ErrorSummary';
import { MutationError } from '../features/common/MutationError';
import { NotAvailableNotice } from '../features/common/NotAvailableNotice';
import { useRetryAction } from '../features/common/useNextAction';
import { paths } from '../features/shell/paths';
import { LimitsCard, StepDetail, StepList } from '../features/workflow-editor/WorkflowEditorPanels';
import { buildPatch, initialForm, issueTarget } from '../features/workflow-editor/workflow-form';
import type { WorkflowForm } from '../features/workflow-editor/workflow-form';
import { useIdempotentMutation } from '../hooks/useIdempotentMutation';
import { useNavPerf } from '../hooks/useNavPerf';
import { useProfiles } from '../hooks/useProfiles';
import { useWorkflow, useWorkflows } from '../hooks/useWorkflow';

/** The version the editor opens: the draft when one exists, else the latest validated version. */
function editableVersion(summary: WorkflowSummary | undefined): number | 'draft' | undefined {
  if (summary === undefined) return undefined;
  if (summary.draftVersion !== null) return 'draft';
  return summary.latestValidatedVersion ?? 'draft';
}

function viewKeyOf(view: WorkflowVersionView): string {
  return `${String(view.version)}:${String(view.draftRevision)}:${view.contentHash}`;
}

/** Workflow editor (10 J10, §5.3, workflow-editor.html): states editing / validation-errors / validated. */
export function WorkflowEditorPage() {
  const { projectId = '', workflowId = '' } = useParams();
  const workflows = useWorkflows();
  const summary = workflows.data?.find((w) => w.id === workflowId);
  const version = editableVersion(summary);
  const viewQ = useWorkflow(workflowId, version);
  const profiles = useProfiles();
  const retry = useRetryAction(() => {
    void workflows.refetch();
    void viewQ.refetch();
  });
  const missing = workflows.data !== undefined && summary === undefined;
  useNavPerf('workflow-editor', viewQ.data !== undefined || viewQ.error !== null || workflows.error !== null || missing);

  const loadError = workflows.error ?? viewQ.error;
  if (loadError !== null || missing || viewQ.data === undefined || summary === undefined) {
    return (
      <>
        <PageHeader title="Workflow editor" breadcrumbs={[{ label: 'Workflows' }]} />
        {loadError !== null ? (
          isNotImplemented(loadError) ? (
            <NotAvailableNotice error={loadError}>Runs keep using the workflow version they were started with.</NotAvailableNotice>
          ) : (
            <ErrorView error={toViewError(loadError)} onAction={retry} />
          )
        ) : missing ? (
          <InlineAlert tone="warning" title="This workflow does not exist">
            <p>
              <Link to={paths.overview(projectId)}>Back to the project overview</Link>
            </p>
          </InlineAlert>
        ) : (
          <div aria-busy="true" className="card">
            <Skeleton lines={10} />
          </div>
        )}
      </>
    );
  }
  return <WorkflowEditor projectId={projectId} summary={summary} view={viewQ.data} profiles={profiles.data ?? []} />;
}

interface WorkflowEditorProps {
  readonly projectId: string;
  readonly summary: WorkflowSummary;
  readonly view: WorkflowVersionView;
  readonly profiles: readonly ProfileWithWarnings[];
}

function WorkflowEditor({ projectId, summary, view, profiles }: WorkflowEditorProps) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const structuralId = useId();
  const viewKey = viewKeyOf(view);
  const [baseKey, setBaseKey] = useState(viewKey);
  const [form, setForm] = useState<WorkflowForm>(() => initialForm(view));
  const [selected, setSelected] = useState<string>(() => view.spec.steps.find((s) => s.kind === 'model')?.id ?? view.spec.steps[0]?.id ?? '');
  const [showPrompt, setShowPrompt] = useState(false);
  const pendingFocus = useRef<string | null>(null);
  const [triedSave, setTriedSave] = useState(false);
  const [validation, setValidation] = useState<{ readonly key: string; readonly result: WorkflowValidationResult } | null>(null);
  const [published, setPublished] = useState<WorkflowVersionView | null>(null);

  const { patch, errors: localErrors } = buildPatch(view, form);
  const dirty = patch !== null || Object.keys(localErrors).length > 0;
  // A new version of the draft (saved here or elsewhere) replaces the form, unless the user is mid-edit.
  if (baseKey !== viewKey) {
    setBaseKey(viewKey);
    if (!dirty) setForm(initialForm(view));
  }

  const save = useMutation({
    mutationFn: () =>
      call('relay/v1/workflows.saveDraft', {
        workflowId: summary.id,
        expectedDraftRevision: view.status === 'draft' ? (view.draftRevision ?? 0) : 0,
        patch: patch ?? {},
      }),
    onSuccess: (saved) => {
      queryClient.setQueryData(qk.workflow(summary.id, 'draft'), saved);
      void queryClient.invalidateQueries({ queryKey: qk.workflows() });
      // The form already holds the saved values; it is re-based when the saved draft becomes the loaded view.
      setTriedSave(false);
    },
  });
  const validate = useMutation({
    mutationFn: (v: number | 'draft') => call('relay/v1/workflows.validate', { workflowId: summary.id, version: v }),
  });
  const publish = useIdempotentMutation('relay/v1/workflows.publish', {
    onSuccess: (res) => {
      queryClient.setQueryData(qk.workflow(summary.id, res.version), res);
      queryClient.removeQueries({ queryKey: qk.workflow(summary.id, 'draft') });
      void queryClient.invalidateQueries({ queryKey: qk.workflows() });
      setValidation(null);
      setPublished(res);
    },
  });

  // A summary link whose field is on another step (or inside the collapsed prompt) focuses after that renders.
  useEffect(() => {
    const id = pendingFocus.current;
    if (id === null || document.getElementById(id) === null) return;
    pendingFocus.current = null;
    focusField(id);
  });

  const currentValidation = validation !== null && validation.key === viewKey ? validation.result : null;
  const issues = currentValidation?.issues ?? [];
  const saveIssues = validationIssuesOf(save.error);
  const fieldErrors: Record<string, string> = {};
  const stepErrorCounts: Record<string, number> = {};
  const problems: FormProblem[] = [];
  for (const issue of [...issues, ...saveIssues]) {
    const target = issueTarget(view, issue.path);
    if (target.fieldId !== null) fieldErrors[target.fieldId] ??= issue.message;
    if (target.stepKey !== null) stepErrorCounts[target.stepKey] = (stepErrorCounts[target.stepKey] ?? 0) + 1;
    problems.push({ fieldId: target.fieldId, message: issue.message, code: issue.code });
  }
  const localProblems: FormProblem[] = triedSave
    ? Object.entries(localErrors).map(([fieldId, message]) => ({ fieldId, message }))
    : [];
  if (triedSave) for (const [id, message] of Object.entries(localErrors)) fieldErrors[id] = message;

  /** Which step a field belongs to (to reveal it before focusing). */
  const stepOfField = (fieldId: string): string | null => {
    for (const s of view.spec.steps) if (fieldId.startsWith(`wf-step-${s.id}`)) return s.id;
    return null;
  };
  const reveal = (p: FormProblem) => {
    if (p.fieldId === null) return;
    const step = stepOfField(p.fieldId);
    const needsStep = step !== null && step !== selected && !p.fieldId.endsWith(`-step-${step}`);
    const needsPrompt = p.fieldId.endsWith('-prompt') && !showPrompt;
    if (!needsStep && !needsPrompt) {
      focusField(p.fieldId);
      return;
    }
    pendingFocus.current = p.fieldId;
    if (needsStep) setSelected(step);
    if (needsPrompt) setShowPrompt(true);
  };

  const latest = summary.latestValidatedVersion;
  const nextVersion = (latest ?? 0) + 1;
  const busy = save.isPending || validate.isPending || publish.isPending;
  const canEdit = Object.entries(view.editable).some(([k, v]) => k !== 'structure' && v);

  const doSave = async (): Promise<WorkflowVersionView | null> => {
    setTriedSave(true);
    if (Object.keys(localErrors).length > 0 || patch === null) return null;
    return save.mutateAsync();
  };

  const onSave = () => {
    doSave()
      .then((saved) => {
        if (saved !== null) {
          toast.show({ key: `wf:saved:${String(saved.draftRevision)}`, title: `Draft revision ${String(saved.draftRevision)} saved`, body: 'Validate it to make it available to new runs.', tone: 'success' });
        }
      })
      .catch(() => undefined);
  };

  const onValidate = () => {
    setPublished(null);
    const run = async () => {
      let target: WorkflowVersionView = view;
      if (dirty) {
        const saved = await doSave();
        if (saved === null) return;
        target = saved;
      }
      const result = await validate.mutateAsync(target.status === 'draft' ? 'draft' : target.version);
      setValidation({ key: viewKeyOf(target), result });
    };
    run().catch(() => undefined);
  };

  const statusBadge = (() => {
    if (published !== null) return <span className="badge success"><CircleCheck aria-hidden="true" /> Validated</span>;
    if (dirty) return <span className="badge">Draft, unsaved changes</span>;
    if (currentValidation !== null && !currentValidation.valid) {
      return <span className="badge danger">{`${String(issues.length)} validation error${issues.length === 1 ? '' : 's'}`}</span>;
    }
    if (currentValidation?.valid === true) return <span className="badge success"><CircleCheck aria-hidden="true" /> Draft valid</span>;
    if (view.status === 'draft') return <span className="badge">Draft, not validated</span>;
    return <span className="badge success">Validated</span>;
  })();

  const versionLabel =
    view.status === 'draft'
      ? `Draft revision ${String(view.draftRevision ?? 0)}${latest === null ? '' : ` · based on v${String(latest)}`}`
      : `Version ${String(view.version)}`;
  const selectedStep = view.spec.steps.find((s) => s.id === selected);
  const selectedIndex = view.spec.steps.findIndex((s) => s.id === selected);

  return (
    <>
      <PageHeader
        title="Workflow editor"
        breadcrumbs={[{ label: 'Workflows' }, { label: summary.name }, { label: versionLabel }]}
        status={statusBadge}
        actions={
          <>
            <Button icon={Save} onClick={onSave} pending={save.isPending && !validate.isPending} disabled={busy || !dirty || !canEdit}>
              Save draft
            </Button>
            <Button variant="primary" icon={ShieldCheck} onClick={onValidate} pending={validate.isPending} disabled={busy}>
              {currentValidation !== null && !currentValidation.valid ? 'Validate again' : 'Validate'}
            </Button>
          </>
        }
      />
      <InlineAlert tone="info" title="New edits affect future runs only.">
        <p>Active runs keep the version they snapshotted. Saving creates a draft revision; publishing makes a validated version for new runs.</p>
      </InlineAlert>
      {published !== null ? (
        <InlineAlert
          tone="success"
          title={`v${String(published.version)} validated — new runs will snapshot v${String(published.version)}; active runs keep their version.`}
          actions={
            <ButtonLink as={Link} size="sm" to={paths.newRun(projectId)}>
              {`Start a run with v${String(published.version)}`}
            </ButtonLink>
          }
        >
          <p>
            Content hash <Hash value={published.contentHash} label="workflow content hash" />. No capability warnings.
          </p>
        </InlineAlert>
      ) : null}
      {localProblems.length > 0 ? (
        <ErrorSummary
          problems={localProblems}
          focusOnMount
          onProblemSelect={reveal}
          title={(n) => `${String(n)} ${n === 1 ? 'problem prevents' : 'problems prevent'} saving this draft`}
        />
      ) : null}
      {problems.length > 0 ? (
        <ErrorSummary
          problems={problems}
          focusOnMount
          onProblemSelect={reveal}
          title={(n) =>
            `${String(n)} ${n === 1 ? 'problem prevents' : 'problems prevent'} ${view.status === 'draft' ? `draft revision ${String(view.draftRevision ?? 0)}` : 'this version'} from starting runs`
          }
          footer={
            saveIssues.length > 0
              ? 'Nothing was saved.'
              : `Draft saved.${latest === null ? '' : ` Version ${String(latest)} remains the version used by new runs until this draft validates.`}`
          }
        />
      ) : null}
      {currentValidation !== null && currentValidation.warnings.length > 0 ? (
        <InlineAlert tone="warning" title="Capability warnings">
          <ul className="small" style={{ margin: 0, paddingLeft: 16 }}>
            {currentValidation.warnings.map((w, i) => (
              <li key={`${w.code}:${String(i)}`}>
                {w.message} <code>{w.code}</code>
              </li>
            ))}
          </ul>
        </InlineAlert>
      ) : null}
      {currentValidation?.valid === true && published === null ? (
        view.status === 'draft' ? (
          <InlineAlert
            tone="success"
            title={`Draft revision ${String(view.draftRevision ?? 0)} is valid`}
            actions={
              <Button
                variant="primary"
                size="sm"
                icon={Upload}
                pending={publish.isPending}
                onClick={() => {
                  publish.mutate({ workflowId: summary.id });
                }}
              >
                {`Publish as v${String(nextVersion)}`}
              </Button>
            }
          >
            <p>Publishing creates immutable version {String(nextVersion)}. New runs snapshot it; active runs keep their version.</p>
          </InlineAlert>
        ) : (
          <InlineAlert tone="success" title={`Version ${String(view.version)} is valid`}>
            <p>There is no draft to publish. Edit a field and save to start a new draft.</p>
          </InlineAlert>
        )
      ) : null}
      <MutationError error={saveIssues.length > 0 ? null : save.error} unavailableHint="Your edits are still in the form; nothing was saved." handlers={{ reload: () => void queryClient.invalidateQueries({ queryKey: qk.workflows() }) }} />
      <MutationError error={validate.error} unavailableHint="The draft is saved; validation is not available in this build." />
      <MutationError error={publish.error} unavailableHint="The draft is saved; new runs keep using the current validated version." />
      <div className="grid grid-cols-[minmax(280px,1fr)_minmax(0,1.6fr)] items-start gap-5 max-[1100px]:grid-cols-1">
        <div className="stack">
          <StepList
            view={view}
            form={form}
            profiles={profiles}
            selected={selected}
            errorCounts={stepErrorCounts}
            structuralId={structuralId}
            onSelect={setSelected}
          />
          <LimitsCard view={view} form={form} errors={fieldErrors} onChange={setForm} />
        </div>
        {selectedStep === undefined ? null : (
          <StepDetail
            key={selectedStep.id}
            view={view}
            step={selectedStep}
            index={selectedIndex}
            form={form}
            profiles={profiles}
            errors={fieldErrors}
            showPrompt={showPrompt}
            onShowPrompt={setShowPrompt}
            onChange={setForm}
          />
        )}
      </div>
      <p className="small muted row" style={{ gap: 6 }}>
        <Lock aria-hidden="true" width={14} height={14} /> Approval steps and the step order are fixed by the template.
      </p>
    </>
  );
}
