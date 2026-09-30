// Per-schema viewers of structured step outputs (10 J8). Every type comes from `@relay/contracts` `outputs/*`
// (never a local copy), so a schema change is a compile error here.
import { useId } from 'react';
import type { ReactNode } from 'react';
import { CircleCheck, CircleX } from 'lucide-react';
import type { FindingsV1, PatchV1, PlanV1, ReviewV1, SourceRef, StepOutput } from '@relay/contracts';
import { LazyDiffViewer } from '../../components/ui';

/** "src/a.ts:12–40" (plain text; paths are project-relative, never absolute). */
export function sourceRefText(ref: SourceRef): string {
  if (ref.startLine === null) return ref.relPath;
  const end = ref.endLine !== null && ref.endLine !== ref.startLine ? `–${String(ref.endLine)}` : '';
  return `${ref.relPath}:${String(ref.startLine)}${end}`;
}

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

function SourceRefs({ refs }: { readonly refs: readonly SourceRef[] }) {
  if (refs.length === 0) return null;
  return (
    <ul className="chip-list" aria-label="Sources">
      {refs.map((r, i) => (
        <li key={`${sourceRefText(r)}-${String(i)}`} className="chip mono">
          {sourceRefText(r)}
        </li>
      ))}
    </ul>
  );
}

function Questions({ questions }: { readonly questions: readonly string[] }) {
  if (questions.length === 0) return null;
  return (
    <div className="stack">
      <h3 className="section-label">Open questions</h3>
      <ul className="small">
        {questions.map((q) => (
          <li key={q}>{q}</li>
        ))}
      </ul>
    </div>
  );
}

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
            <li key={f.id} className="list-item" style={{ cursor: 'default' }}>
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
      <Questions questions={value.unresolvedQuestions} />
    </div>
  );
}

/** `plan.v1`: the proposed plan (read-only; the approval card adds the decision controls). */
export function PlanView({ value }: { readonly value: PlanV1 }) {
  return (
    <div className="stack">
      <p>
        <strong>Goal:</strong> {value.goalRestatement}
      </p>
      <ol className="list">
        {value.steps.map((s) => (
          <li key={s.n} className="list-item" style={{ cursor: 'default' }}>
            <span className="title">
              <span className="num">{s.n}.</span> {s.action}
            </span>
            <span className="meta">
              {s.rationale}
              {s.findingIds.length > 0 ? ` · addresses ${s.findingIds.join(', ')}` : ''}
            </span>
          </li>
        ))}
      </ol>
      <div className="stack">
        <h3 className="section-label">Files the plan may change</h3>
        <ul className="chip-list">
          {value.fileScope.map((f) => (
            <li key={f} className="chip mono">
              {f}
            </li>
          ))}
        </ul>
      </div>
      {value.testSuggestions.length > 0 ? (
        <div className="stack">
          <h3 className="section-label">Suggested tests (proposed, not executed)</h3>
          <ul className="small">
            {value.testSuggestions.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {value.risks.length > 0 ? (
        <div className="stack">
          <h3 className="section-label">Risks</h3>
          <ul className="small">
            {value.risks.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <Questions questions={value.unresolvedQuestions} />
    </div>
  );
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

/** `review.v1`: the verifier's verdict, checks, and requested changes. */
export function ReviewView({ value }: { readonly value: ReviewV1 }) {
  const checksId = useId();
  return (
    <div className="stack">
      <p>
        <strong>{REVIEW_OUTCOME_LABEL[value.outcome]}.</strong> {value.verdictRationale}
      </p>
      <p className="subtle">
        Accepted means the configured workflow accepted the output. It does not guarantee the code is correct.
      </p>
      {value.checks.length > 0 ? (
        <div className="stack">
          <h3 id={checksId} className="section-label">
            Checks
          </h3>
          <ul className="list" aria-labelledby={checksId}>
            {value.checks.map((c) => (
              <li key={c.name} className="list-item" style={{ cursor: 'default' }}>
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
      {value.memoryProposals.length > 0 ? (
        <p className="small">
          {value.memoryProposals.length === 1 ? '1 memory suggestion was' : `${String(value.memoryProposals.length)} memory suggestions were`}{' '}
          proposed. Suggestions are not used by runs until you approve them.
        </p>
      ) : null}
      <SourceRefs refs={value.sourceRefs} />
    </div>
  );
}

/** Any step output, by schema id. `report.v1` (the finalize step) is summarized; the report page shows it in full. */
export function StepOutputView({ output, reportLink }: { readonly output: StepOutput; readonly reportLink?: ReactNode }) {
  switch (output.schemaId) {
    case 'findings.v1':
      return <FindingsView value={output.value} />;
    case 'plan.v1':
      return <PlanView value={output.value} />;
    case 'patch.v1':
      return <PatchView value={output.value} />;
    case 'review.v1':
      return <ReviewView value={output.value} />;
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
