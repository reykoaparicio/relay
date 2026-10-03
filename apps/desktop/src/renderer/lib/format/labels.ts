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
  hard_link: 'Hard-linked file',
};

/**
 * E2 #9: a short explanation shown after a reason label whose label alone does not say why the file is skipped. Only
 * reasons that need one are listed.
 */
export const EXCLUSION_REASON_EXPLANATIONS: Readonly<Partial<Record<ExclusionReason, string>>> = {
  hard_link: 'has more than one hard link, so it may be a file from outside the project; never read',
};

/** A reason as visible text: its label, then its explanation when it has one ("Hard-linked file: has more …"). */
export function exclusionReasonText(reason: ExclusionReason): string {
  const why = EXCLUSION_REASON_EXPLANATIONS[reason];
  return why === undefined ? EXCLUSION_REASON_LABELS[reason] : `${EXCLUSION_REASON_LABELS[reason]}: ${why}`;
}

/**
 * E2 #11 suspected-secret labels (`FileEntry.secretLabel`, `details.denied[].secretLabel`) in words. The label names
 * what the content looks like; the value itself is never sent to the renderer.
 */
export const SECRET_LABELS: Readonly<Record<string, string>> = {
  anthropic_key: 'Anthropic API key',
  openai_key: 'OpenAI API key',
  github_token: 'GitHub token',
  google_api_key: 'Google API key',
  aws_access_key: 'AWS access key',
  private_key: 'private key',
  bearer_token: 'bearer token',
  credential_value: 'credential value',
};

/** A secret label in words; an unknown or missing label is "a credential". */
export function secretLabelText(label: string | undefined | null): string {
  // Own keys only: an engine label such as `constructor` must not reach Object.prototype.
  return label !== undefined && label !== null && Object.hasOwn(SECRET_LABELS, label) ? (SECRET_LABELS[label] ?? 'a credential') : 'a credential';
}

/** "Looks like it contains a secret: Anthropic API key, line 4" (never the value). */
export function suspectedSecretText(label: string | undefined | null, line: number | undefined | null): string {
  const where = line === undefined || line === null ? '' : `, line ${String(line)}`;
  return `Looks like it contains a secret: ${secretLabelText(label)}${where}`;
}

/** E2 #8: an entry that exists but cannot be read. */
export const UNREADABLE_FILE_TEXT = 'Cannot be read (permissions)';

/**
 * Workflow step titles as the user knows them (§5.4 mock). The one label source for step keys: timeline, step
 * header, attempts, ledger, recovery, New run, workflow editor, report.
 */
export const STEP_TITLES: Readonly<Record<string, string>> = {
  intake: 'Read context',
  review: 'Review input',
  plan: 'Plan a fix',
  approve: 'Approve plan',
  implement: 'Produce patch',
  verify: 'Review patch',
  finalize: 'Finalize',
};

/** The title of a step key: the known workflow title, else humanized ("plan_fix" → "Plan fix"). */
export function stepKeyLabel(stepKey: string): string {
  const known = STEP_TITLES[stepKey];
  if (known !== undefined) return known;
  const words = stepKey.replaceAll(/[_-]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** "Run 9T4P": the short, human label of a run id (its last four characters). */
export function runLabel(runId: string): string {
  return `Run ${runId.slice(-4)}`;
}
