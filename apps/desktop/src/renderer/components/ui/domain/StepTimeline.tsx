import { memo, useRef } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import type { StepView } from '@relay/contracts';
import { statusPresentation } from '../../../lib/format/status-presentation';
import type { StatusPresentation } from '../../../lib/format/status-presentation';
import { stepKeyLabel } from '../../../lib/format/labels';
import { ListItemButton } from '../ListItemButton';

export interface StepTimelineProps {
  readonly steps: readonly StepView[];
  readonly selectedId: string | null;
  readonly onSelect: (stepId: StepView['id']) => void;
  /** Display title per step key; defaults to a humanized key ("plan_fix" → "Plan fix"). */
  readonly titleFor?: (step: StepView) => string;
  /** Status shown per step (e.g. "Blocked: run budget" for the step a pause holds back); defaults to the step state. */
  readonly presentationFor?: (step: StepView) => StatusPresentation;
  /** Extra badges under a step (e.g. the step whose request cost more than reserved). */
  readonly badgesFor?: (step: StepView) => ReactNode;
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
function StepTimelineView({ steps, selectedId, onSelect, titleFor, presentationFor, badgesFor, label = 'Run steps' }: StepTimelineProps) {
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
        const p = presentationFor ? presentationFor(step) : statusPresentation('step', step.state);
        const Icon = p.icon;
        const meta = metaLine(step);
        const badges = badgesFor?.(step);
        return (
          <li key={step.id} className={p.tone}>
            <span className="dot" aria-hidden="true">
              <Icon />
            </span>
            <ListItemButton
              className=""
              ref={(el) => {
                if (el) buttons.current.set(step.id, el);
                else buttons.current.delete(step.id);
              }}
              aria-current={step.id === selectedId ? 'step' : undefined}
              onClick={() => { onSelect(step.id); }}
              onKeyDown={(e) => { onKeyDown(e, index); }}
              title={titleFor ? titleFor(step) : stepKeyLabel(step.stepKey)}
              meta={`${p.label}${meta ? ` · ${meta}` : ''}`}
              {...(badges === undefined || badges === null ? {} : { badges })}
            />
          </li>
        );
      })}
    </ol>
  );
}

/** Memoized (PERF-02): re-renders only when its props change, not on every parent tick. */
export const StepTimeline = memo(StepTimelineView);
