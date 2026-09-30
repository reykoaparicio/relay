import { z } from 'zod';
import { idSchema } from '../ids.js';
import { microusdSchema, nonNegativeMicrousdSchema } from '../money.js';
import { epochMsSchema } from '../primitives.js';
import { providerIdSchema } from '../status.js';

/** User exclusion glob (added to the 05 §E2 defaults). */
export const exclusionGlobSchema = z.string().max(200);
/** User exclusion list. */
export const exclusionsSchema = z.array(exclusionGlobSchema).max(100);

/** Per-provider project options (04 §D5 OpenAI `store` toggle). */
export const providerOptionsSchema = z.object({
  openai: z.object({ storeResponses: z.boolean().default(true) }).prefault({}),
});
/** Provider options. */
export type ProviderOptions = z.infer<typeof providerOptionsSchema>;

/** §11.1 project provider policy. */
export const providerPolicySchema = z.object({
  allowedProviderIds: z.array(providerIdSchema),
  providerOptions: providerOptionsSchema.prefault({}),
});
/** Project provider policy. */
export type ProviderPolicy = z.infer<typeof providerPolicySchema>;

/** Project as sent to the renderer. The absolute realpath is NEVER included (only `rootDisplayPath`). */
export const projectSchema = z.object({
  id: idSchema('project'),
  name: z.string().min(1).max(80),
  rootDisplayPath: z.string(), // "~/code/sample-api"
  exclusions: exclusionsSchema,
  providerPolicy: providerPolicySchema,
  monthlyAllowanceMicrousd: nonNegativeMicrousdSchema.nullable(),
  isDemo: z.boolean(), // demo:reset may touch ONLY these (§18.4)
  createdAt: epochMsSchema,
  updatedAt: epochMsSchema,
  archivedAt: epochMsSchema.nullable(),
});
/** Project. */
export type Project = z.infer<typeof projectSchema>;

/** `projects.get` output: project plus dashboard stats. */
export const projectDetailSchema = projectSchema.extend({
  stats: z.object({
    runs: z.number().int().nonnegative(),
    activeRunId: idSchema('run').nullable(),
    approvedMemory: z.number().int().nonnegative(),
    suggestions: z.number().int().nonnegative(),
    trackedMonthMicrousd: microusdSchema,
  }),
});
/** Project detail. */
export type ProjectDetail = z.infer<typeof projectDetailSchema>;
