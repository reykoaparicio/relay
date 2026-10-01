// Public API of @relay/templates (07 G6). Re-exports only.
export { EVAL_TASK_CATEGORIES, EVAL_TASK_ID_PATTERN, evalTaskSchema } from './eval-task.js';
export type { EvalTask } from './eval-task.js';
export { REPORT_LIMITATIONS } from './limitations.js';
export type { ReportLimitationKey, ReportLimitations } from './limitations.js';
export { createTemplateRegistry } from './registry.js';
export type { TemplateRegistry, TemplateSummary, WorkflowSeed } from './registry.js';
export * from './schemas.js';
export { toStrictJsonSchema } from './strict-json-schema.js';
export type { JsonSchema } from './strict-json-schema.js';
