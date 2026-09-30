import type { z } from 'zod';
import type { OutputSchemaId } from './common.js';
import { findingsV1Schema } from './findings.v1.js';
import { patchV1Schema } from './patch.v1.js';
import { planV1Schema } from './plan.v1.js';
import { reportV1Schema } from './report.v1.js';
import { reviewV1Schema } from './review.v1.js';

export * from './common.js';
export * from './findings.v1.js';
export * from './patch.v1.js';
export * from './plan.v1.js';
export * from './report.v1.js';
export * from './review.v1.js';

/** Registry of step output schemas by id (templates re-export it; engine validates with it, 06 F8). */
export const OUTPUT_SCHEMAS = {
  'findings.v1': findingsV1Schema,
  'plan.v1': planV1Schema,
  'patch.v1': patchV1Schema,
  'review.v1': reviewV1Schema,
  'report.v1': reportV1Schema,
} as const satisfies Record<OutputSchemaId, z.ZodType>;
