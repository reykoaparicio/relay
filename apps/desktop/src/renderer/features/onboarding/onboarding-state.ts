// Onboarding wizard state (10 J6): Back and Continue keep everything in a reducer; nothing is persisted until an
// explicit action (create sample/project, connect provider, save rule, start run).
import type { DirectorySelection, ProviderId, ProviderStatus, Role } from '@relay/contracts';
import type { TestOutcome } from '../providers/useProviderMutations';

/** The 8 steps; keys are the route `:step` values and the mock state names (J5). */
export const ONBOARDING_STEPS = [
  { key: 'welcome', label: 'Welcome' },
  { key: 'start-point', label: 'Start point' },
  { key: 'connect-provider', label: 'Provider' },
  { key: 'select-project', label: 'Project folder' },
  { key: 'add-rule', label: 'Project rule' },
  { key: 'choose-template', label: 'Template' },
  { key: 'profiles-and-allowance', label: 'Profiles & allowance' },
  { key: 'review-and-start', label: 'Review & start' },
] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number]['key'];

export function isOnboardingStep(v: unknown): v is OnboardingStep {
  return typeof v === 'string' && ONBOARDING_STEPS.some((s) => s.key === v);
}

export function stepIndex(step: OnboardingStep): number {
  return ONBOARDING_STEPS.findIndex((s) => s.key === step);
}

export type StartPoint = 'sample' | 'own';
export type RuleScope = 'all' | Role;
export type RuleType = 'user_rule' | 'project_decision';

/** One provider connected during this onboarding (redacted status + test outcome; never the key). */
export interface ConnectedProvider {
  readonly providerId: ProviderId;
  readonly status: ProviderStatus;
  readonly test: TestOutcome;
}

export interface OnboardingState {
  readonly startPoint: StartPoint;
  readonly project: { readonly id: string; readonly name: string; readonly isSample: boolean } | null;
  readonly connected: readonly ConnectedProvider[];
  readonly selection: DirectorySelection | null;
  readonly projectName: string;
  readonly exclusionsText: string;
  /** null = default (every connected provider). */
  readonly allowedProviders: readonly ProviderId[] | null;
  readonly ruleText: string;
  readonly ruleType: RuleType;
  readonly ruleScope: RuleScope;
  readonly savedRule: { readonly id: string; readonly revision: number } | null;
  readonly workflow: { readonly id: string; readonly version: number; readonly name: string } | null;
  /** stepKey → profile id chosen on profiles-and-allowance (only changed steps become profileOverrides). */
  readonly profileSelection: Readonly<Record<string, string>>;
  /** null = the workflow default. */
  readonly allowanceText: string | null;
  readonly revisionText: string | null;
  readonly goal: string | null;
}

export const INITIAL_ONBOARDING: OnboardingState = {
  startPoint: 'sample',
  project: null,
  connected: [],
  selection: null,
  projectName: '',
  exclusionsText: '',
  allowedProviders: null,
  ruleText: '',
  ruleType: 'user_rule',
  ruleScope: 'all',
  savedRule: null,
  workflow: null,
  profileSelection: {},
  allowanceText: null,
  revisionText: null,
  goal: null,
};

export type OnboardingAction =
  | { readonly type: 'patch'; readonly patch: Partial<OnboardingState> }
  | { readonly type: 'connected'; readonly entry: ConnectedProvider }
  | { readonly type: 'select-profile'; readonly stepKey: string; readonly profileId: string }
  | { readonly type: 'selection'; readonly selection: DirectorySelection }
  /** The directory selection expired or is unknown to main: choose the folder again. */
  | { readonly type: 'clear-selection' };

/** State that belongs to one project and is reset when `project` changes. */
const PROJECT_DERIVED_RESET = { savedRule: null } as const satisfies Partial<OnboardingState>;

/** True when a directory selection can no longer be used to create the project. */
export function selectionExpired(selection: DirectorySelection, now: number): boolean {
  return now >= selection.expiresAt;
}

/** Last path segment of a display path ("~/code/my-api" → "my-api"). */
function folderName(displayPath: string): string {
  const parts = displayPath.split(/[\\/]/).filter((p) => p !== '');
  return (parts[parts.length - 1] ?? '').slice(0, 80);
}

export function onboardingReducer(state: OnboardingState, action: OnboardingAction): OnboardingState {
  switch (action.type) {
    case 'patch': {
      const next = { ...state, ...action.patch };
      // A saved rule belongs to the project it was saved in: switching projects (sample ↔ own folder) drops it.
      if ('project' in action.patch && (action.patch.project?.id ?? null) !== (state.project?.id ?? null))
        return { ...next, ...PROJECT_DERIVED_RESET };
      return next;
    }
    case 'connected':
      return {
        ...state,
        connected: [...state.connected.filter((c) => c.providerId !== action.entry.providerId), action.entry],
      };
    case 'select-profile':
      return {
        ...state,
        profileSelection: { ...state.profileSelection, [action.stepKey]: action.profileId },
      };
    case 'clear-selection':
      return { ...state, selection: null };
    case 'selection':
      return {
        ...state,
        selection: action.selection,
        projectName:
          state.projectName === '' || state.selection !== null
            ? folderName(action.selection.displayPath)
            : state.projectName,
      };
  }
}

/** Rule title: the first sentence or line of the rule, within the memory title limit. */
export function ruleTitle(text: string, max: number): string {
  const first = text.trim().split(/(?<=[.!?])\s|\n/)[0] ?? '';
  const title = first.replace(/[.!?]+$/, '').trim();
  return title.length <= max ? title : `${title.slice(0, max - 1)}…`;
}
