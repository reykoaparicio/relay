import { useId } from 'react';
import type { Dispatch, ReactNode, SyntheticEvent } from 'react';
import { ArrowLeft } from 'lucide-react';
import { Button } from '../../components/ui';
import type { OnboardingAction, OnboardingState, OnboardingStep } from './onboarding-state';

/** Props every onboarding step receives from the page. */
export interface StepProps {
  readonly state: OnboardingState;
  readonly dispatch: Dispatch<OnboardingAction>;
  readonly go: (step: OnboardingStep) => void;
}

export interface StepFrameProps {
  readonly title: string;
  readonly intro?: ReactNode;
  readonly children?: ReactNode;
  /** Previous step for "Back" (none on the first step). */
  readonly back?: OnboardingStep;
  readonly go: (step: OnboardingStep) => void;
  /** Extra footer buttons placed before the primary one (e.g. "Skip for now"). */
  readonly secondary?: ReactNode;
  /** The primary action; omitted when the step body owns its own submit. */
  /** Replaces the primary action as the form's submit (Enter) handler, e.g. "connect" while a key is typed. */
  readonly onFormSubmit?: (() => void) | undefined;
  readonly primary?: {
    readonly label: string;
    readonly onSubmit: () => void;
    readonly pending?: boolean;
    readonly disabled?: boolean;
    /** Visible reason when disabled (never a disabled button without explanation). */
    readonly disabledReason?: string;
  };
}

/** One wizard step: a labelled card, its body, and a Back / Continue footer submitted as a form. */
export function StepFrame({
  title,
  intro,
  children,
  back,
  go,
  secondary,
  primary,
  onFormSubmit,
}: StepFrameProps) {
  const titleId = useId();
  const reasonId = useId();
  const onSubmit = (e: SyntheticEvent) => {
    e.preventDefault();
    if (onFormSubmit !== undefined) {
      onFormSubmit();
      return;
    }
    if (primary !== undefined && primary.disabled !== true && primary.pending !== true) primary.onSubmit();
  };
  return (
    <section className="card" aria-labelledby={titleId}>
      <form className="stack" onSubmit={onSubmit} noValidate>
        <h2 id={titleId}>{title}</h2>
        {intro === undefined ? null : <div className="muted">{intro}</div>}
        {children}
        <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', marginTop: 8 }}>
          <div>
            {back === undefined ? null : (
              <Button
                variant="ghost"
                icon={ArrowLeft}
                onClick={() => {
                  go(back);
                }}
              >
                Back
              </Button>
            )}
          </div>
          <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            {primary?.disabled === true && primary.disabledReason !== undefined ? (
              <span id={reasonId} className="small subtle">
                {primary.disabledReason}
              </span>
            ) : null}
            {secondary}
            {primary === undefined ? null : (
              <Button
                type="submit"
                variant="primary"
                pending={primary.pending === true}
                disabled={primary.disabled === true}
                aria-describedby={
                  primary.disabled === true && primary.disabledReason !== undefined ? reasonId : undefined
                }
              >
                {primary.label}
              </Button>
            )}
          </div>
        </div>
      </form>
    </section>
  );
}
