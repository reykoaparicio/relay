import { z } from 'zod';
import { handoffBase } from './common.js';

/** `patch.v1`: implementer output (unified diffs; never applied to the project, FR-10). */
export const patchV1Schema = handoffBase.extend({
  outcome: z.literal('patch'),
  files: z
    .array(
      z.object({
        relPath: z.string(),
        changeType: z.enum(['modify', 'add', 'delete']),
        unifiedDiff: z.string(),
      }),
    )
    .min(1)
    .max(20),
  testSuggestions: z.array(z.object({ relPath: z.string().nullable(), description: z.string() })),
  notes: z.string(),
});
/** `patch.v1` value. */
export type PatchV1 = z.infer<typeof patchV1Schema>;
