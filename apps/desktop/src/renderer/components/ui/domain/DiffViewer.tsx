import { useId, useMemo, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { PatchV1 } from '@relay/contracts';
import { parseUnifiedDiff } from './diff-lines';
import type { DiffLine } from './diff-lines';

// Scroll containers are keyboard-focusable natively in Chromium ≥ 130 (Electron 44), so no tabIndex is set.
/** 00b §5: diffs longer than this are virtualized. */
export const DIFF_VIRTUALIZE_THRESHOLD = 500;
const LINE_HEIGHT_PX = 22;

const LINE_CLASS: Readonly<Record<DiffLine['kind'], string>> = {
  add: 'diff-line diff-add',
  del: 'diff-line diff-del',
  hunk: 'diff-line diff-hunk',
  meta: 'diff-line subtle',
  context: 'diff-line',
};

const SR_PREFIX: Readonly<Record<DiffLine['kind'], string>> = {
  add: 'Added: ',
  del: 'Removed: ',
  hunk: '',
  meta: '',
  context: '',
};

const CHANGE_LABEL: Readonly<Record<PatchV1['files'][number]['changeType'], string>> = {
  modify: 'Modified',
  add: 'New file',
  delete: 'Deleted',
};

function Line({ line }: { readonly line: DiffLine }) {
  return (
    <>
      <span className="glyph" aria-hidden="true">
        {line.glyph}
      </span>
      <span>
        {SR_PREFIX[line.kind] ? <span className="sr-only">{SR_PREFIX[line.kind]}</span> : null}
        {line.text}
      </span>
    </>
  );
}

function PlainLines({ lines }: { readonly lines: readonly DiffLine[] }) {
  return (
    <>
      {lines.map((line, i) => (
        <div key={i} className={LINE_CLASS[line.kind]}>
          <Line line={line} />
        </div>
      ))}
    </>
  );
}

function VirtualLines({ lines }: { readonly lines: readonly DiffLine[] }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual returns fresh functions by design
  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => LINE_HEIGHT_PX,
    overscan: 20,
  });
  return (
    <div ref={scrollRef} className="code diff">
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map((item) => {
          const line = lines[item.index];
          if (line === undefined) return null;
          return (
            <div
              key={item.key}
              className={LINE_CLASS[line.kind]}
              style={{ position: 'absolute', top: 0, left: 0, right: 0, height: LINE_HEIGHT_PX, transform: `translateY(${String(item.start)}px)` }}
            >
              <Line line={line} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function FileDiff({ file }: { readonly file: PatchV1['files'][number] }) {
  const headingId = useId();
  const lines = useMemo(() => parseUnifiedDiff(file.unifiedDiff), [file.unifiedDiff]);
  const adds = lines.filter((l) => l.kind === 'add').length;
  const dels = lines.filter((l) => l.kind === 'del').length;
  return (
    <section className="stack" aria-labelledby={headingId}>
      <h3 id={headingId} className="diff-file-header">
        <span>{file.relPath}</span>
        <span className="tag">{CHANGE_LABEL[file.changeType]}</span>
        <span className="subtle">
          +{adds} / −{dels} lines
        </span>
      </h3>
      {lines.length > DIFF_VIRTUALIZE_THRESHOLD ? (
        <VirtualLines lines={lines} />
      ) : (
        <div className="code diff">
          <PlainLines lines={lines} />
        </div>
      )}
    </section>
  );
}

export interface DiffViewerProps {
  readonly files: PatchV1['files'];
}

/** Unified diff with colored lines plus +/− gutter glyphs (never color alone). Load via LazyDiffViewer. */
export function DiffViewer({ files }: DiffViewerProps) {
  return (
    <div className="stack">
      {files.map((f) => (
        <FileDiff key={f.relPath} file={f} />
      ))}
    </div>
  );
}

export default DiffViewer;
