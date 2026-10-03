import type { CSSProperties } from 'react';
import { Check } from 'lucide-react';

export interface StepperStep {
  readonly key: string;
  readonly label: string;
}

export interface StepperProps {
  readonly steps: readonly StepperStep[];
  readonly currentKey: string;
  readonly label: string;
}

/** Wizard progress (onboarding, new run; mock `.stepper`). Done steps say "done" in text, not only with a check. */
export function Stepper({ steps, currentKey, label }: StepperProps) {
  const currentIndex = steps.findIndex((s) => s.key === currentKey);
  return (
    <ol className="stepper" aria-label={label} style={{ '--stepper-count': steps.length } as CSSProperties}>
      {steps.map((s, i) => {
        const isDone = currentIndex > i;
        const isCurrent = i === currentIndex;
        return (
          <li key={s.key} className={isDone ? 'done' : undefined} aria-current={isCurrent ? 'step' : undefined}>
            <span className="n" aria-hidden="true">
              {isDone ? <Check width={12} height={12} /> : i + 1}
            </span>
            <span>
              {s.label}
              {isDone ? <span className="sr-only"> (done)</span> : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
