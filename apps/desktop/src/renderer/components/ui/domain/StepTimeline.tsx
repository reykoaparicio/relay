import { useRef } from 'react';
import type { KeyboardEvent } from 'react';
import type { StepView } from '@relay/contracts';
import { statusPresentation } from '../../../lib/format/status-presentation';
import { stepKeyLabel } from '../../../lib/format/labels';

export interface StepTimelineProps {
  readonly steps: readonly StepView[];
  readonly selectedId: string | null;
  readonly onSelect: (stepId: StepView['id']) => void;
  /** Display title per step key; defaults to a humanized key ("plan_fix" → "Plan fix"). */
  readonly titleFor?: (step: StepView) => string;
  readonly label?: string;
}

function metaLine(step: StepView): string {
  const parts: string[] = [];
  if (step.profileName !== null) parts.push(step.profileName);
  if (step.revisionIndex > 0) parts.push(`revision ${String(step.revisionIndex + 1)}`);
  if (step.retryIndex > 0) parts.push(`retry ${String(step.retryIndex)}`);
  return parts.join(' · ');
}

/** Ordered run steps with a state dot and text state; ArrowUp/ArrowDown/Home/End move the selection. */
export function StepTimeline({ steps, selectedId, onSelect, titleFor, label = 'Run steps' }: StepTimelineProps) {
  const buttons = useRef(new Map<string, HTMLButtonElement>());

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next: number | null = null;
    if (event.key === 'ArrowDown') next = Math.min(steps.length - 1, index + 1);
    else if (event.key === 'ArrowUp') next = Math.max(0, index - 1);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = steps.length - 1;
    const target = next === null ? undefined : steps[next];
    if (target === undefined) return;
    event.preventDefault();
    onSelect(target.id);
    buttons.current.get(target.id)?.focus();
  };

  return (
    <ol className="timeline" aria-label={label}>
      {steps.map((step, index) => {
        const p = statusPresentation('step', step.state);
        const Icon = p.icon;
        const meta = metaLine(step);
        return (
          <li key={step.id} className={p.tone}>
            <span className="dot" aria-hidden="true">
              <Icon />
            </span>
            <button
              type="button"
              ref={(el) => {
                if (el) buttons.current.set(step.id, el);
                else buttons.current.delete(step.id);
              }}
              aria-current={step.id === selectedId ? 'step' : undefined}
              onClick={() => { onSelect(step.id); }}
              onKeyDown={(e) => { onKeyDown(e, index); }}
            >
              <span className="title">{titleFor ? titleFor(step) : stepKeyLabel(step.stepKey)}</span>
              <span className="meta">
                {p.label}
                {meta ? ` · ${meta}` : ''}
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}
