import { useId, useState } from 'react';
import { FileSearch } from 'lucide-react';
import type { ValidationIssue } from '@relay/contracts';
import { Button, Disclosure, Skeleton } from '../../components/ui';
import { useArtifact } from '../../hooks/useArtifact';

export interface ValidationIssueListProps {
  readonly issues: readonly ValidationIssue[];
  /** Behind a disclosure (the plain summary leads; the field list is for whoever wants it). */
  readonly collapsed?: boolean;
  /** Disclosure text when collapsed (default "Fields that did not match (n)"). */
  readonly summary?: string;
}

/** The validation issues of an invalid output, with their JSON paths as text (§5.4 schema-invalid). */
export function ValidationIssueList({ issues, collapsed = false, summary }: ValidationIssueListProps) {
  if (issues.length === 0) return <p className="subtle">The provider response could not be read as the expected output.</p>;
  const list = (
    <ul className="list" aria-label="Validation issues">
      {issues.map((i, n) => (
        <li key={`${i.path}-${String(n)}`} className="list-item static">
          <span className="title mono">{i.path === '' ? '$' : `$.${i.path}`}</span>
          <span className="meta">{i.message}</span>
        </li>
      ))}
    </ul>
  );
  if (!collapsed) return list;
  return <Disclosure summary={summary ?? `Fields that did not match (${String(issues.length)})`}>{list}</Disclosure>;
}

/** "Repair attempts used: 1 of 1" (max shown only when the runner reports it). */
export function repairsText(used: number, max: number | null): string {
  return max === null ? `Repair attempts used: ${String(used)}` : `Repair attempts used: ${String(used)} of ${String(max)}`;
}

/**
 * "View raw response (redacted)": loads the stored raw-response artifact on demand. Redaction happens before the
 * artifact is written (05), so the renderer shows it as-is. Without an artifact id nothing can be shown.
 */
export function RawResponseToggle({ artifactId }: { readonly artifactId: string | null }) {
  const [open, setOpen] = useState(false);
  const regionId = useId();
  const artifact = useArtifact(artifactId, open);
  if (artifactId === null) {
    return <p className="subtle small">No raw response was stored for this attempt.</p>;
  }
  let body = null;
  if (open) {
    if (artifact.error !== null) {
      body = <p className="subtle">The raw response could not be loaded ({artifact.error.message}).</p>;
    } else if (artifact.data === undefined) {
      body = <Skeleton lines={4} />;
    } else {
      const c = artifact.data.content;
      const text = c.kind === 'text' ? c.text : JSON.stringify(c.value, null, 2);
      body = (
        <>
          <pre className="code prewrap" aria-label="Raw response, redacted">
            {text}
          </pre>
          {c.kind === 'text' && c.truncated ? <p className="subtle small">Shown truncated.</p> : null}
        </>
      );
    }
  }
  return (
    <div className="stack">
      <div className="actions">
        <Button
          size="sm"
          variant="ghost"
          icon={FileSearch}
          aria-expanded={open}
          aria-controls={regionId}
          onClick={() => {
            setOpen((v) => !v);
          }}
        >
          {open ? 'Hide raw response' : 'View raw response (redacted)'}
        </Button>
      </div>
      <div id={regionId} hidden={!open}>
        {body}
      </div>
    </div>
  );
}

/** Error code (and support reference) behind a "Technical details" toggle: never the lead of a message. */
export function TechnicalDetails({ error }: { readonly error: { readonly code: string; readonly correlationId?: string | undefined } | null | undefined }) {
  if (error === null || error === undefined) return null;
  return (
    <Disclosure summary="Technical details">
      <p className="subtle">
        Error code <code>{error.code}</code>
        {error.correlationId === undefined ? null : (
          <>
            {' '}· reference <code>{error.correlationId}</code> (include it if you report the problem; it contains no
            project data)
          </>
        )}
      </p>
    </Disclosure>
  );
}

