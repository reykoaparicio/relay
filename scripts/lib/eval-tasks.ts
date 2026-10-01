// 13 §M4 / §17.3: evaluation task files (tests/evaluations/tasks/*.json) — loading and static validation.
// Only `goal`, `input`, and `approvedRules` ever reach a model; `acceptance` and `answerLeakTerms` stay local
// for the founder's scoring (§17.4) and for the "no answer in the prompt" check.
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join, normalize } from 'node:path';
import { evalTaskSchema } from '@relay/templates';
import type { EvalTask } from '@relay/templates';

export type { EvalTask };

/** Paths a run may never select (the fixture's secret and its excluded dirs, 05 exclusions). */
const FORBIDDEN_PATH = /(^|\/)(\.env|node_modules|dist|\.git)(\/|$)/;

/** True when `term` occurs in `text` (case-insensitive; whole word when the term is a plain word). */
export function containsTerm(text: string, term: string): boolean {
  const t = term.toLowerCase();
  const s = text.toLowerCase();
  if (/^[a-z0-9]+$/.test(t)) return new RegExp(`(^|[^a-z0-9])${t}([^a-z0-9]|$)`).test(s);
  return s.includes(t);
}

/** Problems of the task's relPaths: duplicates, non-normalized or escaping paths, excluded paths, missing files. */
async function relPathProblems(relPaths: readonly string[], fileName: string, sampleRoot: string | undefined): Promise<string[]> {
  const p: string[] = [];
  if (new Set(relPaths).size !== relPaths.length) p.push(`${fileName}: duplicate relPaths`);
  for (const r of relPaths) {
    if (r.startsWith('/') || normalize(r) !== r || r.startsWith('..')) {
      p.push(`${fileName}: bad relPath ${r}`);
      continue;
    }
    if (FORBIDDEN_PATH.test(r)) p.push(`${fileName}: relPath ${r} is excluded (secret, dependency, or build output)`);
    if (sampleRoot !== undefined) {
      const st = await lstat(join(sampleRoot, r)).catch(() => null);
      if (st === null || !st.isFile()) p.push(`${fileName}: relPath ${r} is not a file in sample-api`);
    }
  }
  return p;
}

/**
 * Validates one parsed task file: the {@link evalTaskSchema} shape, then the file-level rules (file name = id, no
 * answer term in the goal, §17.3; relPaths inside the sample project). Checks paths against `sampleRoot` when given.
 */
export async function parseTask(raw: unknown, fileName: string, sampleRoot?: string): Promise<{ task: EvalTask | null; problems: string[] }> {
  const parsed = evalTaskSchema.safeParse(raw);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${fileName}: ${i.path.length === 0 ? '(root)' : i.path.join('.')} ${i.message}`);
    return { task: null, problems };
  }
  const t = parsed.data;
  const p: string[] = [];
  if (fileName !== `${t.id}.json`) p.push(`${fileName}: file name must be ${t.id}.json`);
  for (const term of t.answerLeakTerms) if (containsTerm(t.goal, term)) p.push(`${fileName}: goal embeds the answer term "${term}" (§17.3)`);
  p.push(...(await relPathProblems(t.input.relPaths, fileName, sampleRoot)));
  return { task: p.length === 0 ? t : null, problems: p };
}

/** Problems of one parsed task file (empty = valid). Checks paths against `sampleRoot` when given. */
export async function validateTask(raw: unknown, fileName: string, sampleRoot?: string): Promise<string[]> {
  return (await parseTask(raw, fileName, sampleRoot)).problems;
}

/** Loads every task file of `tasksDir`, validated. */
export async function loadTasks(tasksDir: string, sampleRoot?: string): Promise<{ tasks: EvalTask[]; problems: string[] }> {
  const files = (await readdir(tasksDir)).filter((f) => f.endsWith('.json')).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  const tasks: EvalTask[] = [];
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const f of files) {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(join(tasksDir, f), 'utf8')) as unknown;
    } catch (e) {
      problems.push(`${f}: invalid JSON (${e instanceof Error ? e.message : String(e)})`);
      continue;
    }
    const { task, problems: issues } = await parseTask(raw, f, sampleRoot);
    problems.push(...issues);
    if (task !== null) {
      if (ids.has(task.id)) problems.push(`${f}: duplicate id ${task.id}`);
      ids.add(task.id);
      tasks.push(task);
    }
  }
  if (files.length < 6 || files.length > 10) problems.push(`expected 6–10 task files (§17.3), found ${String(files.length)}`);
  const rules = new Set(tasks.map((t) => JSON.stringify(t.approvedRules)));
  if (rules.size > 1) problems.push('every task must use the same approved rules (§17.3 "keep the same approved rules across comparisons")');
  return { tasks, problems };
}

/** Selects tasks by `all` or a comma list of ids or id prefixes (`T1,T2`). */
export function selectTasks(tasks: readonly EvalTask[], spec: string): { selected: EvalTask[]; unknown: string[] } {
  if (spec.trim() === 'all') return { selected: [...tasks], unknown: [] };
  const wanted = spec.split(',').map((s) => s.trim()).filter((s) => s !== '');
  const selected: EvalTask[] = [];
  const unknown: string[] = [];
  for (const w of wanted) {
    const t = tasks.find((x) => x.id === w || x.id.startsWith(`${w}-`));
    if (t === undefined) unknown.push(w);
    else if (!selected.includes(t)) selected.push(t);
  }
  return { selected, unknown };
}
