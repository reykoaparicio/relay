import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { MEMORY_LIMITS, ROLES } from '@relay/contracts';
import type { WorkflowSpec } from '@relay/contracts';
import {
  Button,
  ErrorView,
  Field,
  InlineAlert,
  RadioGroup,
  Select,
  Skeleton,
  Textarea,
} from '../../components/ui';
import { toViewError } from '../../api/errors';
import { MEMORY_TYPE_LABELS } from '../../lib/format';
import { useIdempotentMutation } from '../../hooks/useIdempotentMutation';
import { useWorkflow, useWorkflows } from '../../hooks/useWorkflow';
import { useNextAction, useRetryAction } from '../common/useNextAction';
import { ROLE_LABELS } from '../run-setup/model-steps';
import { ruleTitle } from './onboarding-state';
import type { RuleScope, RuleType } from './onboarding-state';
import { StepFrame } from './StepFrame';
import type { StepProps } from './StepFrame';

/** Shown when a step needs the project created on an earlier step (e.g. after a reload). */
export function MissingPrerequisite({
  go,
  title,
  what,
  step,
}: {
  readonly go: StepProps['go'];
  readonly title: string;
  readonly what: string;
  readonly step: Parameters<StepProps['go']>[0];
}) {
  return (
    <StepFrame title={title} go={go}>
      <InlineAlert
        tone="warning"
        title={`${what} first`}
        actions={
          <Button
            variant="primary"
            onClick={() => {
              go(step);
            }}
          >
            Go to that step
          </Button>
        }
      >
        <p>This step uses a choice from an earlier step, which is kept only while setup is open.</p>
      </InlineAlert>
    </StepFrame>
  );
}

const RULE_PLACEHOLDER = 'Preserve the existing public response format';

/** Step 5 `add-rule`: one approved project rule (`memory.create`, type user_rule). Skippable. */
export function AddRuleStep({ state, dispatch, go }: StepProps) {
  const queryClient = useQueryClient();
  const [showError, setShowError] = useState(false);
  const save = useIdempotentMutation('relay/v1/memory.create', {
    onSuccess: (record) => {
      dispatch({ type: 'patch', patch: { savedRule: { id: record.id, revision: record.currentRevision } } });
      void queryClient.invalidateQueries({ queryKey: ['memory', record.projectId] });
      go('choose-template');
    },
  });
  const onSaveErrorAction = useNextAction({
    fix_input: () => {
      document.querySelector<HTMLElement>('textarea')?.focus();
    },
  });
  const project = state.project;
  if (project === null)
    return (
      <MissingPrerequisite go={go} title="Add one project rule" what="Choose a project" step="start-point" />
    );

  const text = state.ruleText.trim();
  const textError =
    text === ''
      ? 'Write the rule, or skip this step.'
      : text.length > MEMORY_LIMITS.contentMax
        ? `Use at most ${String(MEMORY_LIMITS.contentMax)} characters.`
        : null;
  const skip = () => {
    go('choose-template');
  };
  const onSave = () => {
    setShowError(true);
    if (textError !== null) return;
    save.mutate({
      projectId: project.id,
      type: state.ruleType,
      title: ruleTitle(text, MEMORY_LIMITS.titleMax),
      content: text,
      scope: { roles: state.ruleScope === 'all' ? 'all' : [state.ruleScope] },
      pinned: state.ruleType === 'user_rule',
    });
  };

  if (state.savedRule !== null) {
    return (
      <StepFrame
        title="Add one project rule"
        go={go}
        back="select-project"
        primary={{ label: 'Continue', onSubmit: skip }}
      >
        <InlineAlert tone="success" title="Rule saved">
          <p>
            Approved by you · {MEMORY_TYPE_LABELS[state.ruleType]} ·{' '}
            {state.ruleScope === 'all' ? 'all roles' : ROLE_LABELS[state.ruleScope]} · rev{' '}
            {state.savedRule.revision}
          </p>
          <p className="prewrap">{text}</p>
        </InlineAlert>
      </StepFrame>
    );
  }

  return (
    <StepFrame
      title="Add one project rule"
      intro="Rules are approved memory. Relay includes them in future runs within their scope, and every run keeps a snapshot of the revision it used."
      go={go}
      back="select-project"
      secondary={
        <Button variant="ghost" onClick={skip}>
          Skip for now
        </Button>
      }
      primary={{ label: 'Save rule and continue', onSubmit: onSave, pending: save.isPending }}
    >
      <div className="grid grid-cols-2 gap-4 max-[900px]:grid-cols-1">
        <Field label="Type">
          {(control) => (
            <Select
              {...control}
              value={state.ruleType}
              onValueChange={(v) => {
                dispatch({ type: 'patch', patch: { ruleType: v as RuleType } });
              }}
              options={[
                { value: 'user_rule', label: MEMORY_TYPE_LABELS.user_rule },
                { value: 'project_decision', label: MEMORY_TYPE_LABELS.project_decision },
              ]}
            />
          )}
        </Field>
        <Field label="Scope">
          {(control) => (
            <Select
              {...control}
              value={state.ruleScope}
              onValueChange={(v) => {
                dispatch({ type: 'patch', patch: { ruleScope: v as RuleScope } });
              }}
              options={[
                { value: 'all', label: 'This project · all roles' },
                ...ROLES.map((r) => ({ value: r, label: `This project · ${ROLE_LABELS[r]} only` })),
              ]}
            />
          )}
        </Field>
      </div>
      <Field
        label="Rule"
        required
        hint="A rule guides the models. It cannot change file access, providers or budget limits. No secrets or provider credentials belong in memory."
        error={showError ? textError : null}
      >
        {(control) => (
          <Textarea
            {...control}
            rows={3}
            placeholder={RULE_PLACEHOLDER}
            value={state.ruleText}
            maxLength={MEMORY_LIMITS.contentMax}
            onValueChange={(v) => {
              dispatch({ type: 'patch', patch: { ruleText: v } });
            }}
          />
        )}
      </Field>
      {save.error === null || save.error === undefined ? null : (
        <ErrorView live="assertive" error={toViewError(save.error)} onAction={onSaveErrorAction} />
      )}
    </StepFrame>
  );
}

const OUTPUT_DESCRIPTIONS: Readonly<Record<string, string>> = {
  'findings.v1': 'findings with severity and file references',
  'plan.v1': 'ordered steps and proposed file scope',
  'patch.v1': 'proposed patch, no changes to your files',
  'review.v1': 'accept, request a bounded revision, or mark incomplete',
};

/** Plain-language outline of a template (no graph or orchestration terms, §4.1). */
export function TemplateOutline({ spec }: { readonly spec: WorkflowSpec }) {
  return (
    <ol className="stack small" style={{ margin: 0, paddingLeft: 18 }}>
      <li>
        <strong>Read context</strong> · a fixed record of the selected files and memory
      </li>
      {spec.steps.map((s) => (
        <li key={s.id}>
          {s.kind === 'model' ? (
            <>
              <strong>{ROLE_LABELS[s.role]}</strong> ·{' '}
              {OUTPUT_DESCRIPTIONS[s.outputSchema] ?? 'structured output'}
            </>
          ) : (
            <>
              <strong>Your approval</strong> · tied to this plan and context snapshot
            </>
          )}
        </li>
      ))}
    </ol>
  );
}

/** Step 6 `choose-template`: `workflows.list`; P0 offers only the review-propose-fix template. */
export function ChooseTemplateStep({ state, dispatch, go }: StepProps) {
  const workflows = useWorkflows();
  const offered = (workflows.data ?? []).filter((w) => w.latestValidatedVersion !== null);
  const selectedId = state.workflow?.id ?? offered[0]?.id ?? null;
  const selected = offered.find((w) => w.id === selectedId);
  const version = useWorkflow(selected?.id, selected?.latestValidatedVersion);
  const refetchWorkflows = () => void workflows.refetch();
  const onWorkflowsAction = useRetryAction(refetchWorkflows);

  return (
    <StepFrame
      title="Choose a workflow template"
      go={go}
      back="add-rule"
      primary={{
        label: 'Continue',
        disabled: selected === undefined,
        disabledReason: 'No template is available yet.',
        onSubmit: () => {
          if (selected === undefined || selected.latestValidatedVersion === null) return;
          dispatch({
            type: 'patch',
            patch: {
              workflow: { id: selected.id, version: selected.latestValidatedVersion, name: selected.name },
            },
          });
          go('profiles-and-allowance');
        },
      }}
    >
      {workflows.error === null ? null : (
        <ErrorView error={toViewError(workflows.error)} onAction={onWorkflowsAction} onRetry={refetchWorkflows} />
      )}
      {workflows.data === undefined && workflows.error === null ? (
        <div aria-busy="true">
          <Skeleton lines={3} />
        </div>
      ) : null}
      {offered.length === 0 ? null : (
        <RadioGroup
          legend="Template"
          value={selectedId}
          onValueChange={(id) => {
            const w = offered.find((x) => x.id === id);
            if (w !== undefined && w.latestValidatedVersion !== null)
              dispatch({
                type: 'patch',
                patch: { workflow: { id: w.id, version: w.latestValidatedVersion, name: w.name } },
              });
          }}
          options={offered.map((w) => ({
            value: w.id,
            label: `${w.name} · v${String(w.latestValidatedVersion)}`,
            description:
              'Review a selected change, plan a fix, pause for your approval, draft a patch, then review the patch. Produces a report and an exportable patch.',
          }))}
        />
      )}
      <p className="small muted">
        More templates and structural editing come in a later release. You can edit prompts, profiles and
        limits of this template in Workflows.
      </p>
      {version.data === undefined ? null : (
        <>
          <h3>Steps in this template</h3>
          <TemplateOutline spec={version.data.spec} />
        </>
      )}
    </StepFrame>
  );
}
