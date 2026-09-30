import { z } from 'zod';
import { handoffBase } from './common.js';

/** Review / verification verdicts (`revise` triggers the revision policy, §12.4). */
export const REVIEW_OUTCOMES = ['accept', 'revise', 'incomplete'] as const;
/** Schema for {@link ReviewOutcome}. */
export const reviewOutcomeSchema = z.enum(REVIEW_OUTCOMES);
/** Review outcome. */
export type ReviewOutcome = z.infer<typeof reviewOutcomeSchema>;

/** `review.v1`: verifier output. */
export const reviewV1Schema = handoffBase
  .extend({
    outcome: reviewOutcomeSchema,
    verdictRationale: z.string(),
    requestedChanges: z.array(z.object({ relPath: z.string(), description: z.string() })).max(10),
    checks: z.array(z.object({ name: z.string(), passed: z.boolean(), detail: z.string() })),
    memoryProposals: z
      .array(
        z.object({
          title: z.string(),
          content: z.string(),
          type: z.enum(['user_rule', 'project_decision']),
          rationale: z.string(),
          conflictsWith: z.array(z.string()), // memory record ids the model believes conflict
        }),
      )
      .max(3),
  })
  .superRefine((v, ctx) => {
    if (v.outcome === 'revise' && v.requestedChanges.length < 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['requestedChanges'],
        message: 'revise requires ≥ 1 requested change',
      });
    }
  });
/** `review.v1` value. */
export type ReviewV1 = z.infer<typeof reviewV1Schema>;
