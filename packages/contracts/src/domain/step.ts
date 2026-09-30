import { z } from 'zod';
import { appErrorSchema } from '../errors.js';
import { idSchema } from '../ids.js';
import { stepKeySchema } from '../primitives.js';
import { providerIdSchema, stepStateSchema } from '../status.js';

/** One step row as shown in the run inspector timeline. */
export const stepViewSchema = z.object({
  id: idSchema('stepRun'),
  stepKey: stepKeySchema,
  revisionIndex: z.number().int().nonnegative(),
  retryIndex: z.number().int().nonnegative(),
  state: stepStateSchema,
  profileName: z.string().nullable(), // null for intake/approval/finalize
  providerId: providerIdSchema.nullable(),
  modelId: z.string().nullable(),
  outcome: z.string().nullable(), // output `outcome` field (e.g. 'accept' | 'revise' | 'incomplete' for verify)
  outputArtifactId: idSchema('artifact').nullable(),
  error: appErrorSchema.nullable(),
});
/** Step view. */
export type StepView = z.infer<typeof stepViewSchema>;
