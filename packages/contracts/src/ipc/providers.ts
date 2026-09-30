import { z } from 'zod';
import { RATE_LIMITS } from '../defaults.js';
import { catalogModelSchema } from '../domain/catalog.js';
import { providerStatusSchema } from '../domain/credential.js';
import { appErrorSchema } from '../errors.js';
import { microusdSchema } from '../money.js';
import { costCertaintySchema, credentialStorageModeSchema, providerIdSchema } from '../status.js';
import { emptyInputSchema, op } from './common.js';

/** Bounds on a pasted API key (length only; never logged). */
export const API_KEY_LENGTH = { min: 20, max: 400 } as const;

/** `providers.test` output: a deliberately small request (FR-02), admitted against the setup allowance. */
export const providerTestResultSchema = z.object({
  ok: z.boolean(),
  latencyMs: z.number().int().nonnegative(),
  modelProbed: z.string(),
  error: appErrorSchema.optional(),
  costMicrousd: microusdSchema,
  certainty: costCertaintySchema,
});
/** Provider test result. */
export type ProviderTestResult = z.infer<typeof providerTestResultSchema>;

/** `providers.*` operations. Credentials are main-only (§6.3). */
export const providerOps = {
  'providers.list': op({
    channel: 'relay/v1/providers.list',
    kind: 'query',
    route: 'main+runner',
    input: emptyInputSchema,
    output: z.array(providerStatusSchema),
    errors: [],
    idempotent: false,
  }),
  'providers.connect': op({
    channel: 'relay/v1/providers.connect',
    kind: 'command',
    route: 'main+runner',
    input: z.object({
      providerId: providerIdSchema,
      apiKey: z.string().min(API_KEY_LENGTH.min).max(API_KEY_LENGTH.max),
      storage: credentialStorageModeSchema,
    }),
    output: providerStatusSchema,
    errors: ['SECURE_STORAGE_UNAVAILABLE', 'VALIDATION_FAILED'],
    idempotent: false,
    rateLimit: RATE_LIMITS.credentialConnect,
  }),
  'providers.test': op({
    channel: 'relay/v1/providers.test',
    kind: 'command',
    route: 'main+runner',
    input: z.object({ providerId: providerIdSchema }),
    output: providerTestResultSchema,
    errors: ['AUTH_REQUIRED', 'RATE_LIMITED', 'BUDGET_BLOCKED'],
    idempotent: false,
    rateLimit: RATE_LIMITS.paidTest,
  }),
  'providers.disconnect': op({
    channel: 'relay/v1/providers.disconnect',
    kind: 'command',
    route: 'main+runner',
    input: z.object({ providerId: providerIdSchema }),
    output: providerStatusSchema,
    errors: [],
    idempotent: false,
  }),
  'providers.catalog': op({
    channel: 'relay/v1/providers.catalog',
    kind: 'query',
    route: 'runner',
    input: z.object({ providerId: providerIdSchema.optional() }),
    output: z.array(catalogModelSchema),
    errors: [],
    idempotent: false,
  }),
} as const;
