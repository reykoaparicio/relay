import { z } from 'zod';
import { handoffBase, sourceRefSchema } from './common.js';

/** Maximum findings per review (02 §B11). */
export const MAX_FINDINGS = 20;

/** `findings.v1`: reviewer output. */
export const findingsV1Schema = handoffBase.extend({
  outcome: z.enum(['findings', 'no_issues']),
  findings: z
    .array(
      z.object({
        id: z.string().regex(/^F\d{1,2}$/),
        title: z.string(),
        severity: z.enum(['high', 'medium', 'low', 'info']),
        category: z.enum(['correctness', 'validation', 'error_handling', 'docs', 'style', 'security']),
        description: z.string(),
        sourceRefs: z.array(sourceRefSchema).min(1),
      }),
    )
    .max(MAX_FINDINGS),
});
/** `findings.v1` value. */
export type FindingsV1 = z.infer<typeof findingsV1Schema>;
