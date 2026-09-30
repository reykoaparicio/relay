import { z } from 'zod';
import { approvalViewSchema } from '../domain/approval.js';
import { idSchema } from '../ids.js';
import { idempotencyKeySchema, sha256Schema } from '../primitives.js';
import { approvalDecisionSchema, runStatusSchema } from '../status.js';
import { op } from './common.js';

/** `approvals.decide` input: echoes the hashes the user saw (a mismatch → APPROVAL_STALE, §11.3). */
export const approvalDecideInputSchema = z
  .object({
    idempotencyKey: idempotencyKeySchema,
    approvalId: idSchema('approval'),
    planHash: sha256Schema,
    contextHash: sha256Schema,
    decision: approvalDecisionSchema,
    note: z.string().max(2000).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.decision === 'revision_requested' && (v.note === undefined || v.note.trim() === '')) {
      ctx.addIssue({ code: 'custom', path: ['note'], message: 'a note is required when requesting a revision' });
    }
  });

/** `approvals.*` operations. */
export const approvalOps = {
  'approvals.decide': op({
    channel: 'relay/v1/approvals.decide',
    kind: 'command',
    route: 'runner',
    input: approvalDecideInputSchema,
    output: z.object({ approval: approvalViewSchema, runStatus: runStatusSchema }),
    errors: ['APPROVAL_STALE', 'PROJECT_CHANGED', 'CONFLICT', 'NOT_FOUND'],
    idempotent: true,
  }),
} as const;
