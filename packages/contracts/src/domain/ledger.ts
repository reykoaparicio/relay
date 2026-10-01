import { z } from 'zod';
import { idSchema } from '../ids.js';
import { microusdSchema, nonNegativeMicrousdSchema } from '../money.js';
import { epochMsSchema, stepKeySchema } from '../primitives.js';
import {
  costCertaintySchema,
  ledgerBucketSchema,
  ledgerEntryTypeSchema,
  ledgerScopeSchema,
} from '../status.js';

/** §9.3 balances: allowance L, settled C, reserved R, unknown U (all µUSD). */
export const balancesSchema = z.object({
  L: microusdSchema,
  C: microusdSchema,
  R: microusdSchema,
  U: microusdSchema,
});
/** §9.3 balances. */
export type Balances = z.infer<typeof balancesSchema>;

/** Which admission check a breakdown describes (`setup` = the providers.test allowance). */
export const BUDGET_SCOPES = ['run', 'project', 'setup'] as const;
/** Schema for {@link BudgetScope}. */
export const budgetScopeSchema = z.enum(BUDGET_SCOPES);
/** Budget admission scope. */
export type BudgetScope = z.infer<typeof budgetScopeSchema>;

/** §9.3 admission arithmetic: `C + R + U + N <= L`. Carried in `BUDGET_BLOCKED` details and `runs.preflight`. */
export const budgetBreakdownSchema = balancesSchema.extend({
  N: nonNegativeMicrousdSchema,
  scope: budgetScopeSchema,
  total: microusdSchema, // C + R + U + N
  allowed: z.boolean(), // total <= L (inclusive)
});
/** §9.3 admission breakdown. */
export type BudgetBreakdown = z.infer<typeof budgetBreakdownSchema>;

/** Run/project cost summary shown in the UI; `remaining` may be negative on overrun (§9.5). */
export const costSummarySchema = z.object({
  allowance: microusdSchema,
  settledReported: microusdSchema,
  settledCalculated: microusdSchema,
  settledEstimated: microusdSchema,
  reserved: microusdSchema,
  unknown: microusdSchema,
  remaining: microusdSchema, // allowance − settled − reserved − unknown
  overrun: z.boolean(),
});
/** Cost summary. */
export type CostSummary = z.infer<typeof costSummarySchema>;

/** An amount with its FR-09 certainty label. */
export const costWithCertaintySchema = z.object({ microusd: microusdSchema, certainty: costCertaintySchema });

/** One immutable ledger entry as shown in the Ledger tab / export. */
export const ledgerEntryViewSchema = z.object({
  id: idSchema('ledger'),
  createdAt: epochMsSchema,
  scope: ledgerScopeSchema,
  runId: idSchema('run').nullable(),
  stepKey: stepKeySchema.nullable(),
  attemptId: idSchema('attempt').nullable(),
  type: ledgerEntryTypeSchema,
  bucket: ledgerBucketSchema,
  deltaMicrousd: microusdSchema,
  certainty: costCertaintySchema.nullable(),
  priceCatalogVersion: z.string().nullable(),
  note: z.string().nullable(),
});
/** Ledger entry view. */
export type LedgerEntryView = z.infer<typeof ledgerEntryViewSchema>;
