// The body of a `plan.v1` output: shared by the step panel (read-only) and the ApprovalCard (decision controls), so
// an approver always sees everything the plan contains (unresolved questions, test suggestions, finding ids).
import type { PlanV1, SourceRef } from '@relay/contracts';

/** "src/a.ts:12–40" (plain text; paths are project-relative, never absolute). */
export function sourceRefText(ref: SourceRef): string {
  if (ref.startLine === null) return ref.relPath;
  const end = ref.endLine !== null && ref.endLine !== ref.startLine ? `–${String(ref.endLine)}` : '';
  return `${ref.relPath}:${String(ref.startLine)}${end}`;
}

/** Source references as mono chips (renders nothing when empty). */
export function SourceRefs({ refs }: { readonly refs: readonly SourceRef[] }) {
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

/** "Open questions" list (renders nothing when empty). */
export function OpenQuestions({ questions }: { readonly questions: readonly string[] }) {
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

function TextList({ title, items }: { readonly title: string; readonly items: readonly string[] }) {
  if (items.length === 0) return null;
  return (
    <div className="stack">
      <h3 className="section-label">{title}</h3>
      <ul className="small">
        {items.map((t) => (
          <li key={t}>{t}</li>
        ))}
      </ul>
    </div>
  );
}

export interface PlanBodyProps {
  readonly plan: PlanV1;
  /** The file scope to show; the approval card passes the scope the approval binds (default: the plan's own). */
  readonly fileScope?: readonly string[];
}

/** `plan.v1`: goal, steps (with the findings they address), file scope, sources, tests, risks and open questions. */
export function PlanBody({ plan, fileScope = plan.fileScope }: PlanBodyProps) {
  return (
    <div className="stack">
      <p>
        <strong>Goal:</strong> <span>{plan.goalRestatement}</span>
      </p>
      <ol className="list">
        {plan.steps.map((s) => (
          <li key={s.n} className="list-item static">
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
          {fileScope.map((f) => (
            <li key={f} className="chip mono">
              {f}
            </li>
          ))}
        </ul>
      </div>
      {plan.sourceRefs.length > 0 ? (
        <div className="stack">
          <h3 className="section-label">Sources</h3>
          <SourceRefs refs={plan.sourceRefs} />
        </div>
      ) : null}
      <TextList title="Suggested tests (proposed, not executed)" items={plan.testSuggestions} />
      <TextList title="Risks" items={plan.risks} />
      <OpenQuestions questions={plan.unresolvedQuestions} />
    </div>
  );
}
