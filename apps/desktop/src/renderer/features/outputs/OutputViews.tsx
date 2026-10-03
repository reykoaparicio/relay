// Per-schema viewers of structured step outputs (10 J8). Every type comes from `@relay/contracts` `outputs/*`
// (never a local copy), so a schema change is a compile error here.
import { useId } from 'react';
import type { ReactNode } from 'react';
import { CircleCheck, CircleX } from 'lucide-react';
import { Link } from 'react-router';
import type { FindingsV1, PatchV1, PlanV1, ReviewV1, StepOutput } from '@relay/contracts';
import { LazyDiffViewer, OpenQuestions, PlanBody, SourceRefs } from '../../components/ui';

const SEVERITY_LABEL: Readonly<Record<FindingsV1['findings'][number]['severity'], string>> = {
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  info: 'Info',
};

const SEVERITY_TONE: Readonly<Record<FindingsV1['findings'][number]['severity'], string>> = {
  high: 'danger',
  medium: 'warning',
  low: 'neutral',
  info: 'info',
};

const CATEGORY_LABEL: Readonly<Record<FindingsV1['findings'][number]['category'], string>> = {
  correctness: 'Correctness',
  validation: 'Validation',
  error_handling: 'Error handling',
  docs: 'Docs',
  style: 'Style',
  security: 'Security',
};

export interface FindingsViewProps {
  readonly value: FindingsV1;
  /** Heading level of each finding title (2 on the report page, 3 inside a step panel). */
  readonly headingLevel?: 3 | 4;
}

/** `findings.v1`: reviewer findings with severity as text (never color alone). */
export function FindingsView({ value, headingLevel = 3 }: FindingsViewProps) {
  const Heading = headingLevel === 3 ? 'h3' : 'h4';
  return (
    <div className="stack">
      <p>{value.summary}</p>
      {value.findings.length === 0 ? (
        <p className="subtle">No issues found in the selected input.</p>
      ) : (
        <ol className="list">
          {value.findings.map((f) => (
            <li key={f.id} className="list-item static">
              <span className="row">
                <span className={`badge ${SEVERITY_TONE[f.severity]}`}>{SEVERITY_LABEL[f.severity]}</span>
                <Heading className="title">
                  <span className="mono subtle">{f.id}</span> {f.title}
                </Heading>
                <span className="tag">{CATEGORY_LABEL[f.category]}</span>
              </span>
              <span className="meta">{f.description}</span>
              <SourceRefs refs={f.sourceRefs} />
            </li>
          ))}
        </ol>
      )}
      <OpenQuestions questions={value.unresolvedQuestions} />
    </div>
  );
}

/** `plan.v1`: the proposed plan (read-only; the approval card adds the decision controls around the same body). */
export function PlanView({ value }: { readonly value: PlanV1 }) {
  return <PlanBody plan={value} />;
}

/** Added / removed line counts of a unified diff (file headers excluded). */
export function diffStats(unifiedDiff: string): { readonly adds: number; readonly dels: number } {
  let adds = 0;
  let dels = 0;
  for (const line of unifiedDiff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) adds += 1;
    else if (line.startsWith('-')) dels += 1;
  }
  return { adds, dels };
}

/** `patch.v1`: the proposed patch through the lazy DiffViewer. The patch is never applied (FR-10). */
export function PatchView({ value }: { readonly value: PatchV1 }) {
  return (
    <div className="stack">
      <p>{value.summary}</p>
      <p className="subtle">This patch is a proposal stored with the run. Your project files were not modified.</p>
      <LazyDiffViewer files={value.files} />
      {value.testSuggestions.length > 0 ? (
        <div className="stack">
          <h3 className="section-label">Suggested tests (proposed, not executed)</h3>
          <ul className="small">
            {value.testSuggestions.map((t, i) => (
              <li key={`${t.relPath ?? ''}-${String(i)}`}>
                {t.relPath === null ? null : <span className="mono">{t.relPath}: </span>}
                {t.description}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {value.notes.trim() === '' ? null : <p className="small prewrap">{value.notes}</p>}
    </div>
  );
}

const REVIEW_OUTCOME_LABEL: Readonly<Record<ReviewV1['outcome'], string>> = {
  accept: 'Accepted by the workflow reviewer',
  revise: 'Revision requested by the workflow reviewer',
  incomplete: 'Incomplete',
};

export interface ReviewViewProps {
  readonly value: ReviewV1;
  /**
   * Where the memory suggestions this review proposed are reviewed (the Memory page's Suggested tab); `null` hides the
   * note (a page that lists the run's suggestions elsewhere, e.g. the completed run's banner).
   */
  readonly memoryHref?: string | null;
  /** False when the page already says what "accepted" means (the completed run's banner). */
  readonly showDisclaimer?: boolean;
}

/** `review.v1`: the verifier's verdict, checks, and requested changes. */
export function ReviewView({ value, memoryHref, showDisclaimer = true }: ReviewViewProps) {
  const checksId = useId();
  const proposals = value.memoryProposals.length;
  return (
    <div className="stack">
      <p>
        <strong>{REVIEW_OUTCOME_LABEL[value.outcome]}.</strong> {value.verdictRationale}
      </p>
      {showDisclaimer ? (
        <p className="subtle">
          Accepted means the configured workflow accepted the output. It does not guarantee the code is correct.
        </p>
      ) : null}
      {value.checks.length > 0 ? (
        <div className="stack">
          <h3 id={checksId} className="section-label">
            Checks
          </h3>
          <ul className="list" aria-labelledby={checksId}>
            {value.checks.map((c) => (
              <li key={c.name} className="list-item static">
                <span className="row">
                  {c.passed ? (
                    <CircleCheck aria-hidden="true" width={16} height={16} />
                  ) : (
                    <CircleX aria-hidden="true" width={16} height={16} />
                  )}
                  <span className="title">
                    {c.name}: {c.passed ? 'passed' : 'failed'}
                  </span>
                </span>
                <span className="meta">{c.detail}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {value.requestedChanges.length > 0 ? (
        <div className="stack">
          <h3 className="section-label">Requested changes</h3>
          <ul className="small">
            {value.requestedChanges.map((c, i) => (
              <li key={`${c.relPath}-${String(i)}`}>
                <span className="mono">{c.relPath}</span>: {c.description}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {proposals > 0 && memoryHref !== null ? (
        <p className="small">
          {proposals === 1 ? '1 memory suggestion was' : `${String(proposals)} memory suggestions were`} proposed.
          Suggestions are not used by runs until you approve them.
          {memoryHref === undefined ? null : (
            <>
              {' '}
              <Link to={memoryHref}>{proposals === 1 ? 'Review suggestion' : 'Review suggestions'}</Link>
            </>
          )}
        </p>
      ) : null}
      {value.sourceRefs.length === 0 ? null : (
        <div className="stack">
          <h3 className="section-label">Sources the reviewer cited</h3>
          <SourceRefs refs={value.sourceRefs} />
        </div>
      )}
    </div>
  );
}

/** Any step output, by schema id. `report.v1` (the finalize step) is summarized; the report page shows it in full. */
export interface StepOutputViewProps {
  readonly output: StepOutput;
  readonly reportLink?: ReactNode;
  /** `review.v1` options (see {@link ReviewViewProps}). */
  readonly review?: Omit<ReviewViewProps, 'value'>;
}

export function StepOutputView({ output, reportLink, review = {} }: StepOutputViewProps) {
  switch (output.schemaId) {
    case 'findings.v1':
      return <FindingsView value={output.value} />;
    case 'plan.v1':
      return <PlanView value={output.value} />;
    case 'patch.v1':
      return <PatchView value={output.value} />;
    case 'review.v1':
      return <ReviewView value={output.value} {...review} />;
    case 'report.v1':
      return (
        <div className="stack">
          <p>
            The run report was generated
            {output.value.verdict === null ? '.' : ` (verdict: ${output.value.verdict}).`} Original project files were not
            modified.
          </p>
          {reportLink}
        </div>
      );
  }
}
