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
}

/** Converts Zod issues into {@link ValidationIssue}s (messages truncated to the schema's 400-char limit). */
export function toValidationIssues(issues: readonly IssueLike[]): ValidationIssue[] {
  return issues.map((i) => ({
    path: formatIssuePath(i.path),
    message: i.message.slice(0, 400),
    code: i.code.slice(0, 64),
  }));
}
