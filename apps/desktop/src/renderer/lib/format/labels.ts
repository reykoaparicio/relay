import type { ApprovalDecision, AttemptPurpose, ExclusionReason, MemoryType, ProviderId } from '@relay/contracts';

/** Display names. Exhaustive Records over contracts enums (compile error when an enum grows). */
export const PROVIDER_LABELS: Readonly<Record<ProviderId, string>> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  gemini: 'Google Gemini',
  fake: 'Fake provider',
};

export const MEMORY_TYPE_LABELS: Readonly<Record<MemoryType, string>> = {
  user_rule: 'User rule',
  project_decision: 'Project decision',
  source_reference: 'Source reference',
  run_summary: 'Run summary',
};

/** A recorded approval verdict, lower-case for use mid-sentence ("Decision recorded: revision requested"). */
export const APPROVAL_DECISION_LABELS: Readonly<Record<ApprovalDecision, string>> = {
  approved: 'approved',
  revision_requested: 'revision requested',
  rejected: 'rejected',
};

export const ATTEMPT_PURPOSE_LABELS: Readonly<Record<AttemptPurpose, string>> = {
  initial: 'Initial',
  transport_retry: 'Transport retry',
  schema_repair: 'Schema repair',
  user_retry: 'Retry by you',
  reconcile: 'Reconcile',
};

/** 05 E2 exclusion reasons, shown as visible text beside each excluded file. */
export const EXCLUSION_REASON_LABELS: Readonly<Record<ExclusionReason, string>> = {
  dependency_dir: 'Dependency folder',
  build_output: 'Build output',
  vcs_internal: 'Version control internals',
  secret: 'Possible secret',
  os_file: 'System file',
  binary: 'Binary file',
  too_large: 'Too large',
  gitignored: 'Ignored by .gitignore',
  user_pattern: 'Excluded by your pattern',
  symlink_outside: 'Link outside the project',
  cap_exceeded: 'Over the selection limit',
};

/** "plan_fix" → "Plan fix". Step keys are lowercase identifiers (contracts stepKeySchema). */
export function stepKeyLabel(stepKey: string): string {
  const words = stepKey.replaceAll(/[_-]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
