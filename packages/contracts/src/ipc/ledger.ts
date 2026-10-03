import { z } from 'zod';
import { RATE_LIMITS } from '../defaults.js';
import { costSummarySchema, ledgerEntryViewSchema } from '../domain/ledger.js';
import { idSchema } from '../ids.js';
import { microusdSchema } from '../money.js';
import { monthSchema, stepKeySchema } from '../primitives.js';
import { exportResultSchema, op, pageOf, pageRequestShape } from './common.js';

/** `ledger.runSummary` output. */
export const runCostBreakdownSchema = costSummarySchema.extend({
  byStep: z.array(z.object({ stepKey: stepKeySchema, cost: costSummarySchema })),
});

/** `ledger.projectSummary` output (§9.1 "tracked by Relay"; the provider invoice is authoritative). */
export const projectCostSummarySchema = z.object({
  trackedMicrousd: microusdSchema,
  reservedMicrousd: microusdSchema,
  unknownMicrousd: microusdSchema,
  allowance: microusdSchema.nullable(), // the project's monthly allowance; null = none set
  /** The tracked total includes an estimated amount (decision 1: shown with "~"). */
  hasEstimates: z.boolean(),
  label: z.literal('tracked by Relay'),
});

/** Ledger export target: one run, or one project month. */
export const ledgerExportTargetSchema = z.union([
  z.object({ runId: idSchema('run') }),
  z.object({ projectId: idSchema('project'), month: monthSchema }),
]);

/** `ledger.*` operations. */
export const ledgerOps = {
  'ledger.runSummary': op({
    channel: 'relay/v1/ledger.runSummary',
    kind: 'query',
    route: 'runner',
    input: z.object({ runId: idSchema('run') }),
    output: runCostBreakdownSchema,
    errors: ['NOT_FOUND'],
    idempotent: false,
  }),
  'ledger.projectSummary': op({
    channel: 'relay/v1/ledger.projectSummary',
    kind: 'query',
    route: 'runner',
    input: z.object({ projectId: idSchema('project'), month: monthSchema.optional() }),
    output: projectCostSummarySchema,
    errors: ['NOT_FOUND'],
    idempotent: false,
  }),
  'ledger.entries': op({
    channel: 'relay/v1/ledger.entries',
    kind: 'query',
    route: 'runner',
    input: z.object({ runId: idSchema('run'), ...pageRequestShape }),
    output: pageOf(ledgerEntryViewSchema),
    errors: [],
    idempotent: false,
  }),
  'ledger.export': op({
    channel: 'relay/v1/ledger.export',
    kind: 'command',
    route: 'main+runner',
    input: ledgerExportTargetSchema,
    output: exportResultSchema, // CSV (§5.6 "ledger export")
    errors: ['ARTIFACT_WRITE_FAILED', 'PERMISSION_DENIED', 'NOT_FOUND'],
    idempotent: false,
    rateLimit: RATE_LIMITS.dialog,
  }),
} as const;
