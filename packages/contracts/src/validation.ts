import { z } from 'zod';

/** Field-level validation issue (`error.details.issues`, `workflows.validate`). */
export const validationIssueSchema = z.object({
  path: z.string(),
  message: z.string().max(400),
  code: z.string().max(64),
});
/** Field-level validation issue. */
export type ValidationIssue = z.infer<typeof validationIssueSchema>;

/** Renders a Zod issue path as `steps[1].dependsOn[0]`. The empty path renders as `''`. */
export function formatIssuePath(path: readonly PropertyKey[]): string {
  let out = '';
  for (const seg of path) {
    if (typeof seg === 'number') {
      out += `[${String(seg)}]`;
    } else {
      const name = typeof seg === 'symbol' ? (seg.description ?? 'symbol') : seg;
      out += out === '' ? name : `.${name}`;
    }
  }
  return out;
}

/** Minimal structural view of a Zod issue (keeps this helper independent of Zod internals). */
export interface IssueLike {
  readonly path: readonly PropertyKey[];
  readonly message: string;
  readonly code: string;
  /** Present on Zod `unrecognized_keys` issues. */
  readonly keys?: readonly string[];
}

const toIssue = (path: readonly PropertyKey[], message: string, code: string): ValidationIssue => ({
  path: formatIssuePath(path),
  message: message.slice(0, 400),
  code: code.slice(0, 64),
});

/**
 * Converts Zod issues into {@link ValidationIssue}s (messages truncated to the schema's 400-char limit). An
 * `unrecognized_keys` issue becomes one field-specific issue per unknown key (e.g. `steps[0].temperature`, §5.3).
 */
export function toValidationIssues(issues: readonly IssueLike[]): ValidationIssue[] {
  return issues.flatMap((i) =>
    i.code === 'unrecognized_keys' && i.keys !== undefined && i.keys.length > 0
      ? i.keys.map((k) => toIssue([...i.path, k], `unknown key "${k}"`, i.code))
      : [toIssue(i.path, i.message, i.code)],
  );
}
