// The Output tab of the selected step (10 J8): approval card, streaming attempt card, schema-invalid step, or the
// per-schema output viewer. Everything is typed from `@relay/contracts`.
import { Link } from 'react-router';
import { planV1Schema } from '@relay/contracts';
import type { ApprovalDecision, AttemptView, PlanV1, RunDetail, RunEvent, StepDetail, StepView } from '@relay/contracts';
import {
  ApprovalCard,
  EmptyState,
  InlineAlert,
  KeyValueList,
  Money,
  Skeleton,
  StatusBadge,
} from '../../components/ui';
import type { ApprovalDecisionInput } from '../../components/ui';
import { formatDuration, formatTokens, PROVIDER_LABELS } from '../../lib/format';
import { isNotImplemented } from '../../api/errors';
import { useArtifact } from '../../hooks/useArtifact';
import { useStep } from '../../hooks/useStep';
import { NotAvailableNotice } from '../common/NotAvailableNotice';
import { PlanView, StepOutputView } from '../outputs/OutputViews';
import { paths } from '../shell/paths';
import { ActionErrorNotice } from './ActionErrorNotice';
import { issuesOf, numberDetail, stepTitle, stringDetail } from './inspector-model';
import { RawResponseToggle, repairsText, ValidationIssueList } from './StepIssues';

// ---------------------------------------------------------------------------------------------------------------
// Streaming attempt (running-streaming)

function progressFor(progress: ReadonlyMap<string, RunEvent>, attempt: AttemptView | undefined, step: StepView): RunEvent | undefined {
  // Progress is keyed by attempt id when the event names one, else by step: use the newest of the two.
  const byAttempt = attempt === undefined ? undefined : progress.get(attempt.id);
  const byStep = progress.get(`step:${step.stepKey}`);
  if (byAttempt === undefined) return byStep;
  if (byStep === undefined) return byAttempt;
  return byStep.seq > byAttempt.seq ? byStep : byAttempt;
}

function num(e: RunEvent | undefined, key: string): number | null {
  const v = e?.payload[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export interface StreamingAttemptCardProps {
  readonly run: RunDetail;
  readonly step: StepView;
  readonly attempt: AttemptView | undefined;
  readonly progress: RunEvent | undefined;
  readonly now: number;
}

/**
 * An executing attempt: elapsed time, provider latency vs app time (shown separately, R3-20), and the output token
 * count from `attempt.stream_progress` — never the content (§5.7). No per-token announcements.
 */
export function StreamingAttemptCard({ run, step, attempt, progress, now }: StreamingAttemptCardProps) {
  const elapsed = attempt === undefined ? null : Math.max(0, now - attempt.startedAt);
  // Provider time (first byte → now, as of the latest progress event) and app time (reserve → dispatch overhead),
  // shown separately (R3-20). Settled attempts carry both measured values.
  const progressElapsed = num(progress, 'elapsedMs');
  const providerMs = attempt?.providerLatencyMs ?? progressElapsed;
  let appMs: number | null = null;
  if (attempt?.appElapsedMs != null && attempt.providerLatencyMs != null) {
    appMs = Math.max(0, attempt.appElapsedMs - attempt.providerLatencyMs);
  } else if (attempt !== undefined && progress !== undefined && progressElapsed !== null) {
    appMs = Math.max(0, progress.at - attempt.startedAt - progressElapsed);
  }
  const tokens = num(progress, 'outputTokensSoFar');
  return (
    <section className="card" aria-labelledby="streaming-attempt-title">
      <div className="card-header">
        <h3 id="streaming-attempt-title">
          {attempt === undefined ? 'Preparing the request' : `Attempt #${String(attempt.seq)}`}
        </h3>
        <StatusBadge kind="step" value={step.state} />
      </div>
      <p className="subtle">
        {step.profileName ?? 'Profile'}
        {step.providerId === null ? '' : ` · ${PROVIDER_LABELS[step.providerId]}`}
        {step.modelId === null ? '' : ` · ${step.modelId}`}
      </p>
      <p>Receiving response… Relay will announce when the step finishes.</p>
      <KeyValueList
        items={[
          { id: 'elapsed', term: 'Elapsed', value: elapsed === null ? 'Starting' : formatDuration(elapsed), mono: true },
          { id: 'provider', term: 'Provider latency', value: providerMs === null ? 'Waiting for the first byte' : formatDuration(providerMs), mono: true },
          { id: 'app', term: 'App processing', value: appMs === null ? 'Measuring' : formatDuration(appMs), mono: true },
          {
            id: 'tokens',
            term: 'Output so far',
            value: tokens === null ? 'No output yet' : <span data-testid="stream-tokens">{formatTokens(tokens)} tokens est.</span>,
            mono: true,
          },
          { id: 'reserved', term: 'Reserved for this request', value: <Money value={run.cost.reserved} /> },
        ]}
      />
      <div aria-hidden="true">
        <Skeleton lines={3} />
      </div>
      <p className="subtle small">
        Partial output is buffered and validated once complete. The app stays usable; you can leave this page.
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Schema-invalid step (repairing, or failed validation while the run is not yet paused)

export function isSchemaInvalidStep(run: RunDetail, step: StepView): boolean {
  const invalid = step.state === 'validating' || (step.state === 'failed' && step.error?.code === 'OUTPUT_INVALID');
  return invalid && step.error?.code === 'OUTPUT_INVALID' && !(run.status === 'paused' && run.pauseReason === 'output_invalid');
}

export function SchemaInvalidCard({ step, attempts }: { readonly step: StepView; readonly attempts: readonly AttemptView[] }) {
  const err = step.error;
  const schemaId = stringDetail(err, 'schemaId');
  const used = numberDetail(err, 'repairsUsed') ?? attempts.filter((a) => a.purpose === 'schema_repair').length;
  const max = numberDetail(err, 'repairsMax');
  return (
    <InlineAlert
      tone="warning"
      title={schemaId === null ? 'The output did not match the expected format' : `The output did not match ${schemaId}`}
    >
      <p>
        {repairsText(used, max)}.{' '}
        {step.state === 'validating'
          ? 'Relay is asking the model to repair the output.'
          : 'Relay pauses the run if repairs are used up.'}
      </p>
      <ValidationIssueList issues={issuesOf(err)} />
      <RawResponseToggle artifactId={stringDetail(err, 'rawResponseArtifactId')} />
      {err === null ? null : (
        <p className="subtle">
          Error code <code>{err.code}</code>
        </p>
      )}
    </InlineAlert>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Approval

/** The plan the approval binds (`planArtifactId`): from the plan step's output, else `artifacts.get`. */
function useApprovalPlan(run: RunDetail): { plan: PlanV1 | undefined; error: unknown } {
  const approval = run.pendingApproval;
  const planStep = approval === null ? undefined : run.steps.find((s) => s.outputArtifactId === approval.planArtifactId);
  const stepQ = useStep(run.id, planStep?.id);
  const artifactQ = useArtifact(approval?.planArtifactId, approval !== null && planStep === undefined);
  const fromStep = stepQ.data?.output?.schemaId === 'plan.v1' ? stepQ.data.output.value : undefined;
  const raw = artifactQ.data?.content.kind === 'json' ? planV1Schema.safeParse(artifactQ.data.content.value) : undefined;
  const fromArtifact = raw?.success === true ? raw.data : undefined;
  return { plan: fromStep ?? fromArtifact, error: stepQ.error ?? artifactQ.error };
}

export interface ApprovalOutputProps {
  readonly run: RunDetail;
  readonly canDecide: boolean;
  readonly onDecide: (input: ApprovalDecisionInput) => void;
  readonly pendingDecision: ApprovalDecision | null;
  readonly error: unknown;
  /** Shown when approvals.decide answered APPROVAL_STALE / PROJECT_CHANGED (the run was refetched). */
  readonly staleNotice: boolean;
}

export function ApprovalOutput({ run, canDecide, onDecide, pendingDecision, error, staleNotice }: ApprovalOutputProps) {
  const { plan, error: loadError } = useApprovalPlan(run);
  const approval = run.pendingApproval;
  const stale = staleNotice ? (
    <InlineAlert tone="warning" title="The plan or files changed since you opened this page">
      <p>Relay refreshed the run. Review the current plan and hashes before deciding again.</p>
    </InlineAlert>
  ) : null;
  if (approval === null) return stale;
  if (plan === undefined) {
    if (loadError !== null && loadError !== undefined) {
      return isNotImplemented(loadError) ? (
        <NotAvailableNotice error={loadError}>The plan is stored with the run and can be reviewed after updating Relay.</NotAvailableNotice>
      ) : (
        <ActionErrorNotice error={loadError} />
      );
    }
    return <Skeleton lines={6} />;
  }
  return (
    <div className="stack">
      {stale}
      {canDecide ? (
        <ApprovalCard approval={approval} plan={plan} onDecide={onDecide} pendingDecision={pendingDecision} />
      ) : (
        <PlanView value={plan} />
      )}
      <ActionErrorNotice error={error} fallback="The plan is unchanged and still waiting for your decision." />
    </div>
  );
}

/** approval-stale: the plan that was proposed (read-only), from the step that produced it. */
function ProposedPlan({ run, step }: { readonly run: RunDetail; readonly step: StepView }) {
  const index = run.steps.findIndex((s) => s.id === step.id);
  const source = run.steps.slice(0, Math.max(0, index)).reverse().find((s) => s.outputArtifactId !== null);
  const q = useStep(run.id, source?.id);
  const output = q.data?.output;
  if (source === undefined) return <p>The proposed plan is not available.</p>;
  if (q.error !== null) return <ActionErrorNotice error={q.error} />;
  if (output === undefined) return <Skeleton lines={5} />;
  return (
    <div className="stack">
      <h3 className="section-label">The plan that was proposed</h3>
      {output?.schemaId === 'plan.v1' ? <PlanView value={output.value} /> : <p>The proposed plan is not available.</p>}
      <p className="subtle">It can no longer be approved as is: the files it was planned against changed.</p>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Output tab

export interface StepOutputTabProps {
  readonly run: RunDetail;
  readonly projectId: string;
  readonly step: StepView;
  readonly detail: StepDetail | undefined;
  readonly detailError: unknown;
  readonly progress: ReadonlyMap<string, RunEvent>;
  readonly now: number;
  readonly approval: Omit<ApprovalOutputProps, 'run'>;
}

export function StepOutputTab({ run, projectId, step, detail, detailError, progress, now, approval }: StepOutputTabProps) {
  const isApprovalStep = step.state === 'awaiting_approval' || (step.stepKey === 'approve' && run.pendingApproval !== null);
  if (isApprovalStep && run.pendingApproval !== null) return <ApprovalOutput run={run} {...approval} />;
  if (step.stepKey === 'approve' && run.status === 'paused' && run.pauseReason === 'approval_stale') {
    return <ProposedPlan run={run} step={step} />;
  }
  if (detailError !== null && detailError !== undefined) return <ActionErrorNotice error={detailError} />;
  if (detail === undefined) return <Skeleton lines={5} />;
  if (step.state === 'executing' || step.state === 'reserved') {
    const attempt = detail.attempts.at(-1);
    return <StreamingAttemptCard run={run} step={step} attempt={attempt} progress={progressFor(progress, attempt, step)} now={now} />;
  }
  if (isSchemaInvalidStep(run, step)) return <SchemaInvalidCard step={step} attempts={detail.attempts} />;
  if (detail.output !== null) {
    return (
      <StepOutputView
        output={detail.output}
        reportLink={
          run.reportArtifactId === null ? undefined : <Link to={paths.report(projectId, run.id)}>Open the run report</Link>
        }
      />
    );
  }
  if (step.error !== null) {
    return (
      <InlineAlert tone={step.state === 'unknown' ? 'unknown' : 'danger'} title={`${stepTitle(step)}: ${step.error.userMessage}`}>
        <p className="subtle">
          Error code <code>{step.error.code}</code>
        </p>
      </InlineAlert>
    );
  }
  const bodyByState: Partial<Record<StepView['state'], string>> = {
    pending: 'This step has not started. Nothing has been sent for it.',
    ready: 'This step is next. Nothing has been sent for it yet.',
    skipped: 'This step was skipped; it will not run.',
    unknown: 'The provider may have processed this request. The run shows how to resolve it.',
    succeeded: 'This step finished without a stored output.',
    failed: 'This step did not produce a valid output.',
  };
  return (
    <EmptyState
      headingLevel={3}
      title={`${stepTitle(step)}: no output`}
      body={bodyByState[step.state] ?? 'No output yet.'}
    />
  );
}
