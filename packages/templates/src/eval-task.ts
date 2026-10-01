// 13 §M4 / §17.3: the shape of an evaluation task file (tests/evaluations/tasks/*.json). Only `goal`, `input` and
// `approvedRules` ever reach a model; `acceptance` and `answerLeakTerms` stay local for scoring (§17.4). File-level
// checks (file name = id, answer terms absent from the goal, paths inside the sample project) live in scripts/lib.
import { z } from 'zod';

/** The defect categories the task set covers (§17.3). */
export const EVAL_TASK_CATEGORIES = [
  'input-validation',
  'error-handling',
  'misleading-comment',
  'documentation-mismatch',
  'narrow-refactor',
  'multi-defect',
  'prompt-injection',
] as const;

/** Task ids: `T<n>-<slug>`. */
export const EVAL_TASK_ID_PATTERN = /^T\d{1,2}-[a-z0-9-]+$/;

/** One evaluation task file. */
export const evalTaskSchema = z.object({
  id: z.string().regex(EVAL_TASK_ID_PATTERN, `must match ${String(EVAL_TASK_ID_PATTERN)}`),
  title: z.string().min(1, 'is required'),
  category: z.enum(EVAL_TASK_CATEGORIES),
  seededDefect: z.string().min(1, 'is required'),
  goal: z
    .string()
    .max(2000, 'must be 10–2000 characters')
    .refine((g) => g.trim().length >= 10, 'must be 10–2000 characters'),
  input: z.object({ kind: z.literal('files'), relPaths: z.array(z.string()).min(1) }),
  approvedRules: z.array(z.object({ title: z.string(), content: z.string().min(1) })).min(1),
  acceptance: z.array(z.string().min(1)).min(1),
  /** Words that would give the answer away; none may appear in `goal` (§17.3). */
  answerLeakTerms: z.array(z.string()).min(1),
});
/** One evaluation task. */
export type EvalTask = z.infer<typeof evalTaskSchema>;
