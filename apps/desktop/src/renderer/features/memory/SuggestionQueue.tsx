import { useLayoutEffect, useMemo, useRef } from 'react';
import type { RefObject } from 'react';
import type { MemoryRecordView } from '@relay/contracts';
import { SuggestionCard } from './SuggestionCard';
import type { useMemoryMutations } from './useMemoryMutations';

export interface SuggestionQueueProps {
  readonly projectId: string;
  readonly suggestions: readonly MemoryRecordView[];
  readonly titleOf: (id: string) => string | undefined;
  readonly mutations: ReturnType<typeof useMemoryMutations>;
  readonly onCombine: (suggestion: MemoryRecordView, withId?: string) => void;
}

function focusIsLost(): boolean {
  const active = document.activeElement;
  return active === null || active === document.body || active === document.documentElement;
}

/**
 * A11Y-02: a decision (approve / reject / combine) removes its card, and the focused button with it. Focus moves to
 * the next suggestion's heading (the one that took the removed card's place), or to the queue heading when the queue
 * is now empty or the removed card was the last one.
 */
function useFocusNextSuggestion(ids: readonly string[], container: RefObject<HTMLElement | null>, heading: RefObject<HTMLElement | null>) {
  const previous = useRef(ids);
  useLayoutEffect(() => {
    const before = previous.current;
    previous.current = ids;
    const removedAt = before.findIndex((id) => !ids.includes(id));
    if (removedAt === -1 || !focusIsLost()) return;
    const nextId = ids[removedAt];
    const next =
      nextId === undefined ? null : container.current?.querySelector<HTMLElement>(`[data-suggestion-heading="${CSS.escape(nextId)}"]`);
    (next ?? heading.current)?.focus();
  }, [ids, container, heading]);
}

/** The suggestions queue (memory `suggestions` state): one SuggestionCard per proposal, oldest first. */
export function SuggestionQueue({ projectId, suggestions, titleOf, mutations, onCombine }: SuggestionQueueProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const ids = useMemo(() => suggestions.map((s) => s.id), [suggestions]);
  useFocusNextSuggestion(ids, containerRef, headingRef);
  return (
    <div ref={containerRef} className="stack">
      <div className="stack" style={{ gap: 4 }}>
        <h2 ref={headingRef} tabIndex={-1}>{`Review queue: ${String(suggestions.length)} suggestion${suggestions.length === 1 ? '' : 's'}`}</h2>
        <p className="muted">
          Approving creates a durable record included in future runs within its scope. Rejected suggestions are kept in
          run history only.
        </p>
      </div>
      {suggestions.map((s) => (
        <SuggestionCard
          key={s.id}
          projectId={projectId}
          suggestion={s}
          titleOf={titleOf}
          mutations={mutations}
          onCombine={(_id, withId) => {
            onCombine(s, withId);
          }}
        />
      ))}
    </div>
  );
}
