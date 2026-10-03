// `runs.preflight` issues (06 F14 readiness) as the new-run form and onboarding show them. The engine reports, per
// model step at `profileOverrides.<stepKey>`: unknown_profile, provider_not_allowed, missing_credential, model_unknown
// and the other capability codes; and budget_run / budget_project when the first reservation is not admitted (the
// same fact as `budget.allowed = false`, which the budget card already shows). The renderer never re-checks: it only
// groups and words what the engine returned.
import type { ProfileWithWarnings, ProviderId, ValidationIssue } from '@relay/contracts';
import { PROVIDER_LABELS } from '../../lib/format';
import type { ModelStepRow } from './model-steps';

/** Issue codes that restate `budget.allowed = false` (shown by the budget card, not as a separate problem). */
const BUDGET_ISSUE_CODES: ReadonlySet<string> = new Set(['budget_run', 'budget_project']);

/** The issue a connected provider fixes (Settings → Providers). */
export const MISSING_CREDENTIAL = 'missing_credential';

function isBudgetIssue(i: Pick<ValidationIssue, 'code'>): boolean {
  return BUDGET_ISSUE_CODES.has(i.code);
}

/**
 * The issues to list as problems. A budget issue is dropped while the budget card is shown (`budgetShown`), so the
 * same block is never reported twice; without the card (an older engine, or a disagreement) it stays a problem.
 */
export function problemIssues(issues: readonly ValidationIssue[], budgetShown: boolean): ValidationIssue[] {
  return budgetShown ? issues.filter((i) => !isBudgetIssue(i)) : [...issues];
}

/** The step key of a `profileOverrides.<stepKey>` issue path, else null. */
export function stepKeyOfPath(path: string): string | null {
  return /^profileOverrides\.([a-z][a-z0-9_-]*)/.exec(path)?.[1] ?? null;
}

/** The provider of the profile a step would use: the user's selection, else the spec default. */
export function stepProviderId(
  stepKey: string,
  rows: readonly ModelStepRow[],
  selection: Readonly<Record<string, string>>,
  profiles: readonly ProfileWithWarnings[] | undefined,
): ProviderId | null {
  const row = rows.find((r) => r.stepKey === stepKey);
  const profileId = selection[stepKey] ?? row?.defaultProfileId ?? null;
  if (profileId === null) return null;
  return profiles?.find((p) => p.profile.id === profileId)?.profile.providerId ?? null;
}

function providerLabel(id: ProviderId | null): string {
  return id === null ? 'this provider' : PROVIDER_LABELS[id];
}

/** The issue code of a file that looks like it contains a secret (E2 #11). */
export const SUSPECTED_SECRET = 'suspected_secret';

/**
 * A suspected secret in a file an imported diff touches. A diff input cannot acknowledge one (the engine fails
 * closed), so "confirm sending it" cannot be followed here: the fix is to remove the secret, or switch to Selected
 * files and confirm the file there.
 */
export function diffSecretMessage(relPath: string | null): string {
  return `The imported diff touches ${relPath ?? 'a file'}, which looks like it contains a secret. Remove the secret from that file, or use Selected files and confirm it there.`;
}

/** The file an engine `suspected_secret` issue names (`"src/x.ts" looks like it contains a secret. …`), else null. */
function secretFileOfMessage(message: string): string | null {
  return /^"([^"]+)" looks like it contains a secret/.exec(message)?.[1] ?? null;
}

/**
 * The problem text of an issue. A missing credential names the provider and the fix (the engine's message is generic
 * because a ValidationIssue carries no provider); a suspected secret at `input` (a diff input, which cannot confirm
 * one) gets advice that can be followed; every other issue keeps the engine's message.
 */
export function issueMessage(i: ValidationIssue, providerId: ProviderId | null, stepTitle: string | null): string {
  if (i.code === SUSPECTED_SECRET && i.path === 'input') return diffSecretMessage(secretFileOfMessage(i.message));
  if (i.code !== MISSING_CREDENTIAL) return i.message;
  const who = stepTitle === null ? '' : `${stepTitle}: `;
  return `${who}no API key is connected for ${providerLabel(providerId)}. Connect it, or choose a profile whose provider is connected.`;
}
