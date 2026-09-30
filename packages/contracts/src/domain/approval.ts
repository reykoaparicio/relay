import { z } from 'zod';
import { idSchema } from '../ids.js';
import { epochMsSchema, relPathSchema, sha256Schema } from '../primitives.js';
import { approvalDecisionSchema, providerIdSchema } from '../status.js';

/** §11.3 approval as shown to the user (the hashes are echoed back by approvals.decide). */
export const approvalViewSchema = z.object({
  id: idSchema('approval'),
  planHash: sha256Schema,
  contextHash: sha256Schema,
  fileScope: z.array(relPathSchema),
  providers: z.array(providerIdSchema), // providers that will receive context after approval (§11.3)
  planArtifactId: idSchema('artifact'),
  decision: approvalDecisionSchema.nullable(),
  createdAt: epochMsSchema,
});
/** Approval view. */
export type ApprovalView = z.infer<typeof approvalViewSchema>;
