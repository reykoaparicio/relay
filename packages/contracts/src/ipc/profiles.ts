import { z } from 'zod';
import { modelProfileInputSchema, modelProfileSchema } from '../domain/profile.js';
import { capabilityWarningSchema } from '../domain/workflow.js';
import { idSchema } from '../ids.js';
import { emptyInputSchema, op } from './common.js';

/** A profile with the engine's capability warnings (06 F14); the renderer never re-checks. */
export const profileWithWarningsSchema = z.object({
  profile: modelProfileSchema,
  warnings: z.array(capabilityWarningSchema),
});
/** Profile with warnings. */
export type ProfileWithWarnings = z.infer<typeof profileWithWarningsSchema>;

/** `profiles.*` operations. */
export const profileOps = {
  'profiles.list': op({
    channel: 'relay/v1/profiles.list',
    kind: 'query',
    route: 'runner',
    input: emptyInputSchema,
    output: z.array(profileWithWarningsSchema),
    errors: [],
    idempotent: false,
  }),
  'profiles.upsert': op({
    channel: 'relay/v1/profiles.upsert',
    kind: 'command',
    route: 'runner',
    input: z.object({
      profile: modelProfileInputSchema,
      expectedRevision: z.number().int().positive().optional(),
    }),
    output: profileWithWarningsSchema,
    errors: ['MODEL_UNSUPPORTED', 'CONFLICT', 'NOT_FOUND'],
    idempotent: false,
  }),
  'profiles.delete': op({
    channel: 'relay/v1/profiles.delete',
    kind: 'command',
    route: 'runner',
    input: z.object({ profileId: idSchema('profile') }),
    output: z.object({ deleted: z.literal(true) }),
    errors: ['CONFLICT', 'NOT_FOUND'],
    idempotent: false,
  }),
} as const;
