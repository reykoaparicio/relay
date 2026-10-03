// E2 #11 (audit F1): content check for credential-shaped text in project files that passed the name rules. A hit is
// a SUSPECTED secret: the preview flags it (never selected by default) and intake refuses it unless the run's input
// explicitly acknowledges it. Only a coarse, fixed label and a line number ever leave this module — never the match.
import { findSecretMatches, looksLikeSecret } from '@relay/contracts';

/** What kind of credential the content looks like (fixed vocabulary; safe to show and log). */
export type SuspectedSecretLabel =
  | 'anthropic_key'
  | 'openai_key'
  | 'github_token'
  | 'google_api_key'
  | 'aws_access_key'
  | 'private_key'
  | 'bearer_token'
  | 'credential_value';

/** One suspected secret in a file: its label and 1-based line. */
export interface SuspectedSecret {
  readonly label: SuspectedSecretLabel;
  readonly line: number;
}

/** Content larger than this is checked only in its first {@link SECRET_SCAN_MAX_CHARS} characters (bounded cost). */
export const SECRET_SCAN_MAX_CHARS = 1024 * 1024;

function labelOf(match: string): SuspectedSecretLabel {
  if (/sk-ant-/.test(match)) return 'anthropic_key';
  if (/\bsk-|^sk-/.test(match)) return 'openai_key';
  if (/gh[pousr]_|github_pat_/.test(match)) return 'github_token';
  if (/AIza/.test(match)) return 'google_api_key';
  if (/AKIA[0-9A-Z]{16}/.test(match)) return 'aws_access_key';
  if (/PRIVATE KEY-----/.test(match)) return 'private_key';
  if (/Bearer\s/i.test(match)) return 'bearer_token';
  return 'credential_value';
}

function lineAt(text: string, index: number): number {
  let line = 1;
  for (let i = text.indexOf('\n'); i !== -1 && i < index; i = text.indexOf('\n', i + 1)) line += 1;
  return line;
}

/**
 * The first credential-shaped value in `content`, or null. Every candidate of the shared redaction rules
 * (`findSecretMatches`) is confirmed with `looksLikeSecret` (match plus its next character), as the scanners do, so a
 * key NAME followed by prose ("apiKey: fromVault()") is not a hit.
 */
export function detectSuspectedSecret(content: string): SuspectedSecret | null {
  const text = content.length > SECRET_SCAN_MAX_CHARS ? content.slice(0, SECRET_SCAN_MAX_CHARS) : content;
  let best: { index: number; match: string } | null = null;
  for (const m of findSecretMatches(text)) {
    if (best !== null && m.index >= best.index) continue;
    const next = text.charAt(m.index + m.match.length);
    if (looksLikeSecret(`${m.match}${next}`)) best = m;
  }
  return best === null ? null : { label: labelOf(best.match), line: lineAt(text, best.index) };
}

/** One acknowledgement of a suspected secret: the file and the sha256 of the content the user confirmed (round-3 M4). */
export interface SecretAcknowledgement {
  readonly relPath: string;
  readonly sha256: string;
}

/**
 * THE suspected-secret predicate (E2 #11) shared by every gate: `runs.preflight` (engine run-start.ts), intake and
 * re-snapshot (`readSelected` with `secretCheck`, read.ts). The hit for `file` unless an acknowledgement names its
 * relPath AND the sha256 of its CURRENT bytes (round-3 M4: an acknowledgement is bound to the content the user saw — a
 * changed file, e.g. a real key pasted over an acknowledged test token, is checked and flagged again), else null. One
 * function so preflight and intake can never disagree about the same file.
 *
 * Diff-input runs carry no acknowledgement (the `diff` run input has no `acknowledgedSuspectedSecrets`), so callers pass
 * `[]` for them: a suspected secret in any current file the diff references blocks the run (fail closed). The user
 * removes the secret, excludes the file, or selects files instead (where it can be acknowledged).
 */
export function unacknowledgedSuspectedSecret(
  file: { readonly relPath: string; readonly content: string; readonly sha256: string },
  acknowledged: readonly SecretAcknowledgement[],
): SuspectedSecret | null {
  const acked = acknowledged.some((a) => a.relPath === file.relPath && a.sha256 === file.sha256);
  return acked ? null : detectSuspectedSecret(file.content);
}
