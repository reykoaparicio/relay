// 13 §M4 / §17.5: renders the pitch evidence table from evaluation results and the founder's hand scores.
//
//   tsx --conditions=development scripts/evidence-table.ts --results tests/evaluations/results/<date>
//
// Inputs (all optional; whatever is missing renders as "Not yet measured"):
//   <results>/<config>/<task>-<n>.json   written by scripts/evaluate.ts (config = relay | single-agent)
//   <results>/scores.csv                 filled BY HAND (tests/evaluations/rubric.md); `manual` rows = the manual baseline
// Rules: it never invents a number. The denominator of "accepted / total" counts EVERY attempted run — completed,
// incomplete, failed, cancelled, and runs stopped by the cost cap; only runs the founder accepted under the rubric
// (accepted = yes with correctness 2 and coverage 2) count in the numerator. Every cell shows its sample size.
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { EvalResult } from './lib/eval-results.js';

const NOT_MEASURED = 'Not yet measured';
const NOT_OBSERVED = 'Not yet observed';
const NOT_APPLICABLE = 'Not applicable';
const COLUMNS = ['manual', 'single-agent', 'relay'] as const;
type Column = (typeof COLUMNS)[number];

/** One scores.csv row (strings as typed by the founder). */
interface ScoreRow {
  readonly config: string;
  readonly task: string;
  readonly repeat: string;
  readonly accepted: string;
  readonly correctness: string;
  readonly coverage: string;
  readonly reviewMinutes: string;
  readonly setupMinutes: string;
}

/** Minimal RFC 4180 CSV parser (quoted fields, doubled quotes). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (quoted) {
      if (ch === '"' && text.charAt(i + 1) === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text.charAt(i + 1) === '\n') i += 1;
      row.push(cell);
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows;
}

async function readScores(dir: string): Promise<ScoreRow[]> {
  const text = await readFile(join(dir, 'scores.csv'), 'utf8').catch(() => '');
  const [header, ...rows] = parseCsv(text);
  if (header === undefined) return [];
  const col = (name: string): number => header.findIndex((h) => h.trim().toLowerCase() === name);
  const at = (r: string[], name: string): string => (col(name) < 0 ? '' : (r[col(name)] ?? '').trim());
  return rows.map((r) => ({
    config: at(r, 'config'), task: at(r, 'task'), repeat: at(r, 'repeat'), accepted: at(r, 'accepted').toLowerCase(),
    correctness: at(r, 'correctness'), coverage: at(r, 'coverage'), reviewMinutes: at(r, 'review_minutes'), setupMinutes: at(r, 'setup_minutes'),
  }));
}

async function readResults(dir: string): Promise<EvalResult[]> {
  const out: EvalResult[] = [];
  for (const config of ['relay', 'single-agent']) {
    const files = await readdir(join(dir, config)).catch(() => [] as string[]);
    for (const f of files.filter((x) => x.endsWith('.json'))) {
      out.push(JSON.parse(await readFile(join(dir, config, f), 'utf8')) as EvalResult);
    }
  }
  return out;
}

/** True when a score row meets the rubric's acceptance rule (§17.4). */
function isAccepted(s: ScoreRow | undefined): boolean {
  return s !== undefined && s.accepted === 'yes' && s.correctness === '2' && s.coverage === '2';
}

function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
}

const nums = (xs: readonly string[]): number[] => xs.filter((x) => x !== '' && Number.isFinite(Number(x))).map(Number);
const usd = (micro: number): string => `$${(micro / 1_000_000).toFixed(2)}`;

/** One rendered cell and whether it holds a measurement. */
interface Cell {
  readonly text: string;
  readonly measured: boolean;
}

/** The §17.5 table as data. */
function buildTable(results: readonly EvalResult[], scores: readonly ScoreRow[]): { rows: { metric: string; cells: Record<Column, Cell> }[]; notes: string[] } {
  const scoreOf = (config: string, task: string, repeat: number): ScoreRow | undefined =>
    scores.find((s) => s.config === config && s.task === task && Number(s.repeat) === repeat);
  const notes: string[] = [];

  const accepted = {} as Record<Column, Cell>;
  const minutes = {} as Record<Column, Cell>;
  const cost = {} as Record<Column, Cell>;
  const setup = {} as Record<Column, Cell>;
  for (const c of COLUMNS) {
    if (c === 'manual') {
      // Manual baseline attempts exist only as scores.csv rows (recorded by hand, docs/product/baseline-notes.md).
      const rows = scores.filter((s) => s.config === 'manual');
      const scored = rows.filter((s) => s.accepted !== '');
      accepted[c] = rows.length === 0 || scored.length < rows.length
        ? { text: rows.length === 0 ? NOT_MEASURED : `${NOT_MEASURED} (${String(rows.length - scored.length)} of ${String(rows.length)} unscored)`, measured: false }
        : rate(rows.filter(isAccepted).length, rows.length);
      cost[c] = { text: NOT_MEASURED, measured: false };
    } else {
      const runs = results.filter((r) => r.config === c);
      // Denominator: every attempted run. Only completed runs can be accepted; they need a human score first.
      const completed = runs.filter((r) => r.status === 'completed');
      const unscored = completed.filter((r) => (scoreOf(c, r.taskId, r.repeat)?.accepted ?? '') === '').length;
      const acc = completed.filter((r) => isAccepted(scoreOf(c, r.taskId, r.repeat))).length;
      accepted[c] = runs.length === 0 ? { text: NOT_MEASURED, measured: false }
        : unscored > 0 ? { text: `${NOT_MEASURED} (${String(unscored)} of ${String(runs.length)} runs unscored)`, measured: false }
        : rate(acc, runs.length);
      if (runs.length > 0) {
        const byStatus = new Map<string, number>();
        for (const r of runs) {
          const k = r.stopReason === 'cost_cap' ? 'stopped by cost cap' : r.status;
          byStatus.set(k, (byStatus.get(k) ?? 0) + 1);
        }
        notes.push(`${c}: n = ${String(runs.length)} attempted run(s) — ${[...byStatus].map(([k, v]) => `${String(v)} ${k}`).join(', ')}.`);
      }
      const settled = runs.reduce((s, r) => s + r.costs.settledReportedMicrousd + r.costs.settledCalculatedMicrousd + r.costs.settledEstimatedMicrousd, 0);
      const unknown = runs.reduce((s, r) => s + r.costs.unknownMicrousd, 0);
      const estimated = runs.reduce((s, r) => s + r.costs.settledEstimatedMicrousd, 0);
      cost[c] = runs.length === 0 ? { text: NOT_MEASURED, measured: false }
        : { text: `${usd(settled)} tracked (${usd(estimated)} of it estimated; ${usd(unknown)} unknown) over n = ${String(runs.length)}`, measured: true };
    }
    const mins = nums(scores.filter((s) => s.config === c).map((s) => s.reviewMinutes));
    minutes[c] = mins.length === 0 ? { text: NOT_MEASURED, measured: false } : { text: `${String(median(mins))} min (n = ${String(mins.length)})`, measured: true };
    const set = nums(scores.filter((s) => s.config === c).map((s) => s.setupMinutes));
    setup[c] = set.length === 0 ? { text: NOT_MEASURED, measured: false } : { text: `${String(median(set))} min (n = ${String(set.length)})`, measured: true };
  }
  const repeatUsers: Record<Column, Cell> = {
    manual: { text: NOT_APPLICABLE, measured: false },
    'single-agent': { text: NOT_APPLICABLE, measured: false },
    relay: { text: NOT_OBSERVED, measured: false },
  };
  return {
    rows: [
      { metric: 'Accepted tasks / total', cells: accepted },
      { metric: 'Median human intervention minutes', cells: minutes },
      { metric: 'Total tracked model cost', cells: cost },
      { metric: 'Median setup time', cells: setup },
      { metric: 'Repeat users', cells: repeatUsers },
    ],
    notes,
  };
}

function rate(num: number, den: number): Cell {
  return { text: `${String(num)}/${String(den)} (${String(Math.round((num / den) * 100))}%)`, measured: true };
}

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { results: { type: 'string' } }, strict: true });
  const dir = values.results === undefined ? null : resolve(values.results);
  const results = dir === null ? [] : await readResults(dir);
  const scores = dir === null ? [] : await readScores(dir);
  const { rows, notes } = buildTable(results, scores);
  const lines = [
    '| Metric | Manual baseline | Single-agent baseline | Relay | Evidence status |',
    '| --- | --- | --- | --- | --- |',
    ...rows.map((r) => {
      const measured = COLUMNS.some((c) => r.cells[c].measured);
      const status = r.metric === 'Repeat users' ? NOT_OBSERVED : measured ? 'Measured (see n per cell)' : NOT_MEASURED;
      return `| ${r.metric} | ${r.cells.manual.text} | ${r.cells['single-agent'].text} | ${r.cells.relay.text} | ${status} |`;
    }),
    '',
    `Sample: ${String(results.length)} evaluation run(s) from ${dir ?? '(no results dir)'}; ${String(scores.filter((s) => s.config === 'manual').length)} manual baseline attempt(s).`,
    ...notes,
    'Accepted = founder-scored accepted=yes with correctness 2 and coverage 2 (tests/evaluations/rubric.md). The denominator counts every attempted run, including incomplete, failed, cancelled, and cost-cap stops.',
    'Single-agent baseline = the reduced evaluation pipeline (plan + one implementer pass), see tests/evaluations/rubric.md. Tracked cost is tracked usage, not a provider bill.',
    '',
  ];
  process.stdout.write(lines.join('\n'));
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    process.stderr.write(`evidence-table failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
    process.exitCode = 1;
  },
);
