import { z } from 'zod';
import { handoffBase } from './common.js';

/** `plan.v1`: planner output; its hash and `fileScope` are bound into the approval (§11.3). */
export const planV1Schema = handoffBase.extend({
  outcome: z.literal('plan'),
  goalRestatement: z.string(),
  steps: z
    .array(
      z.object({
        n: z.number().int().positive(),
        action: z.string(),
        rationale: z.string(),
        findingIds: z.array(z.string()),
      }),
    )
    .min(1)
    .max(12),
  fileScope: z.array(z.string()).min(1).max(20), // relPaths
  testSuggestions: z.array(z.string()).max(10),
  risks: z.array(z.string()),
  decisions: z.array(z.object({ title: z.string(), content: z.string() })).max(3), // candidate memory (07 G5)
});
/** `plan.v1` value. */
export type PlanV1 = z.infer<typeof planV1Schema>;
