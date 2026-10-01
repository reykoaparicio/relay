// 13 §M4 / §17.3: evaluation task files (tests/evaluations/tasks/*.json) — loading and static validation.
// Only `goal`, `input`, and `approvedRules` ever reach a model; `acceptance` and `answerLeakTerms` stay local
// for the founder's scoring (§17.4) and for the "no answer in the prompt" check.
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join, normalize } from 'node:path';

/** One evaluation task. */
export interface EvalTask {
  readonly id: string;
  readonly title: string;
  readonly category: string;
  readonly seededDefect: string;
  readonly goal: string;
  readonly input: { readonly kind: 'files'; readonly relPaths: readonly string[] };
  readonly approvedRules: readonly { readonly title: string; readonly content: string }[];
  readonly acceptance: readonly string[];
  /** Words that would give the answer away; none may appear in `goal` (§17.3). */
  readonly answerLeakTerms: readonly string[];
}

const ID_RE = /^T\d{1,2}-[a-z0-9-]+$/;
const CATEGORIES = new Set(['input-validation', 'error-handling', 'misleading-comment', 'documentation-mismatch', 'narrow-refactor', 'multi-defect', 'prompt-injection']);
/** Paths a run may never select (the fixture's secret and its excluded dirs, 05 exclusions). */
const FORBIDDEN_PATH = /(^|\/)(\.env|node_modules|dist|\.git)(\/|$)/;

const isStr = (v: unknown): v is string => typeof v === 'string';
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** True when `term` occurs in `text` (case-insensitive; whole word when the term is a plain word). */
export function containsTerm(text: string, term: string): boolean {
  const t = term.toLowerCase();
  const s = text.toLowerCase();
  if (/^[a-z0-9]+$/.test(t)) return new RegExp(`(^|[^a-z0-9])${t}([^a-z0-9]|$)`).test(s);
  return s.includes(t);
}

/** Problems of one parsed task file (empty = valid). Checks paths against `sampleRoot` when given. */
export async function validateTask(raw: unknown, fileName: string, sampleRoot?: string): Promise<string[]> {
  const p: string[] = [];
  if (!isObj(raw)) return [`${fileName}: not a JSON object`];
  const { id, title, category, seededDefect, goal, input, approvedRules, acceptance, answerLeakTerms } = raw;
  if (!isStr(id) || !ID_RE.test(id)) p.push(`${fileName}: id must match ${String(ID_RE)}`);
  else if (fileName !== `${id}.json`) p.push(`${fileName}: file name must be ${id}.json`);
  if (!isStr(title) || title.length === 0) p.push(`${fileName}: title is required`);
  if (!isStr(category) || !CATEGORIES.has(category)) p.push(`${fileName}: category must be one of ${[...CATEGORIES].join(', ')}`);
  if (!isStr(seededDefect) || seededDefect.length === 0) p.push(`${fileName}: seededDefect is required`);
  if (!isStr(goal) || goal.trim().length < 10 || goal.length > 2000) p.push(`${fileName}: goal must be 10–2000 characters`);
  if (!Array.isArray(answerLeakTerms) || answerLeakTerms.length === 0 || !answerLeakTerms.every(isStr)) {
    p.push(`${fileName}: answerLeakTerms must be a non-empty string array`);
  } else if (isStr(goal)) {
    for (const term of answerLeakTerms) if (containsTerm(goal, term)) p.push(`${fileName}: goal embeds the answer term "${term}" (§17.3)`);
  }
  if (!isObj(input) || input['kind'] !== 'files' || !Array.isArray(input['relPaths']) || input['relPaths'].length === 0) {
    p.push(`${fileName}: input must be { kind: 'files', relPaths: [...] }`);
  } else {
    const rel = input['relPaths'] as unknown[];
    if (new Set(rel).size !== rel.length) p.push(`${fileName}: duplicate relPaths`);
    for (const r of rel) {
      if (!isStr(r) || r.startsWith('/') || normalize(r) !== r || r.startsWith('..')) {
        p.push(`${fileName}: bad relPath ${String(r)}`);
        continue;
      }
      if (FORBIDDEN_PATH.test(r)) p.push(`${fileName}: relPath ${r} is excluded (secret, dependency, or build output)`);
      if (sampleRoot !== undefined) {
        const st = await lstat(join(sampleRoot, r)).catch(() => null);
        if (st === null || !st.isFile()) p.push(`${fileName}: relPath ${r} is not a file in sample-api`);
      }
    }
  }
  if (!Array.isArray(approvedRules) || approvedRules.length === 0) {
    p.push(`${fileName}: approvedRules must be a non-empty array`);
  } else {
    for (const r of approvedRules) if (!isObj(r) || !isStr(r['title']) || !isStr(r['content']) || r['content'].length === 0) p.push(`${fileName}: each approved rule needs title and content`);
  }
  if (!Array.isArray(acceptance) || acceptance.length === 0 || !acceptance.every((a) => isStr(a) && a.length > 0)) {
    p.push(`${fileName}: acceptance must be a non-empty string array`);
  }
  return p;
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
    const issues = await validateTask(raw, f, sampleRoot);
    problems.push(...issues);
    if (issues.length === 0) {
      const t = raw as EvalTask;
      if (ids.has(t.id)) problems.push(`${f}: duplicate id ${t.id}`);
      ids.add(t.id);
      tasks.push(t);
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
