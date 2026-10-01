// 13 §M4 / §17.3–17.5: the evaluation harness.
//
//   tsx --conditions=development scripts/evaluate.ts --dry-run --tasks all [--config relay|single-agent|both] [--repeat n]
//   RELAY_LIVE_TESTS=1 tsx --conditions=development scripts/evaluate.ts --config both --tasks T1,T2 --repeat 2 --cap-usd 5
//
// --dry-run validates every task file and prints the planned runs, their model steps, and an estimated cost UPPER
// BOUND per run (the run budget the engine enforces), using the FAKE provider for preflight only: no request leaves
// the machine and nothing is spent. Live mode refuses to start unless RELAY_LIVE_TESTS=1 AND --cap-usd are given; it
// reads provider keys from this process's environment only (never a .env file, never the app's credential store),
// stops before any run whose budget would cross the cap, and never scores quality (§17.4, §7.7: the founder fills
// scores.csv by hand).
//
// Every run composes through createRuntime from @relay/engine (06 F16); the single-agent config passes the
// evaluation-only registry (scripts/lib/eval-templates.ts) as `templates`.
import { cp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { err, errors, microusd, ok } from '@relay/contracts';
import type { ProjectId, ProviderId, RunId, RunStatus, WorkflowId } from '@relay/contracts';
import { createRuntime } from '@relay/engine';
import type { Runtime } from '@relay/engine';
import { cleanupScratchDirs, exists, makeScratchDir } from './lib/demo-fs.js';
import { callOk, memoryLogger, sleep } from './lib/demo-runtime.js';
import { REPO_ROOT } from './lib/demo-state.js';
import { loadTasks, selectTasks } from './lib/eval-tasks.js';
import type { EvalTask } from './lib/eval-tasks.js';
import type { EvalConfig, EvalResult } from './lib/eval-results.js';
import { RELAY_SLUG, SINGLE_STEP_SLUG, createEvalRegistry } from './lib/eval-templates.js';

const TASKS_DIR = join(REPO_ROOT, 'tests', 'evaluations', 'tasks');
const SAMPLE = join(REPO_ROOT, 'tests', 'fixtures', 'sample-api');
const RESULTS_DIR = join(REPO_ROOT, 'tests', 'evaluations', 'results');
const KEY_ENV: Readonly<Record<string, string>> = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', gemini: 'GEMINI_API_KEY' };
const ALLOWED_PROVIDERS: readonly ProviderId[] = ['anthropic', 'openai', 'gemini'];
const RUN_TIMEOUT_MS = 30 * 60_000;
const MAX_REPEAT = 5;

const SLUG: Record<EvalConfig, string> = { relay: RELAY_SLUG, 'single-agent': SINGLE_STEP_SLUG };

interface PlannedRun {
  readonly order: number;
  readonly config: EvalConfig;
  readonly task: EvalTask;
  readonly repeat: number;
}

/** Deterministic shuffle (mulberry32), so a randomized order (§17.3) is reproducible from --seed. */
function shuffle<T>(items: readonly T[], seed: number): T[] {
  let s = seed >>> 0;
  const rand = (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

const usd = (micro: number): string => `$${(micro / 1_000_000).toFixed(2)}`;

/** Fresh userData + sample copy + project + approved rules for one config (fake or live). */
async function openWorkspace(scratch: string, name: string, mode: 'fake' | 'live', task: EvalTask): Promise<{ rt: Runtime; projectId: ProjectId; workflowIds: Map<string, WorkflowId>; userDataDir: string }> {
  const userDataDir = join(scratch, name, 'userdata');
  const sampleRoot = join(scratch, name, 'project', 'sample-api');
  await mkdir(join(scratch, name, 'project'), { recursive: true });
  await cp(SAMPLE, sampleRoot, { recursive: true, verbatimSymlinks: true, filter: (p) => !p.endsWith('/.env') && !p.endsWith('/.relay-fixture.json') });
  const root = await realpath(sampleRoot);
  const rt = await createRuntime({
    userDataDir,
    providerMode: mode,
    ...(mode === 'fake' ? { fakeScenario: 'happy-path' } : {}),
    credentials: {
      resolve: (req) => {
        if (mode === 'fake') return Promise.resolve(ok('eval-fake-key-not-a-secret'));
        const v = process.env[KEY_ENV[req.providerId] ?? '']?.trim();
        return Promise.resolve(v === undefined || v === '' ? err(errors.authRequired(req.providerId)) : ok(v));
      },
    },
    templates: createEvalRegistry(REPO_ROOT),
    logger: memoryLogger(),
    idleMs: 50,
  });
  try {
    const project = await callOk(rt, 'relay/v1/projects.createFromRoot', {
      idempotencyKey: `eval-project-${name}`.slice(0, 64).padEnd(10, '0'), rootRealpath: root, rootDisplayPath: '~/sample-api', name: 'Sample API (evaluation)',
      exclusions: [], allowedProviderIds: [...ALLOWED_PROVIDERS], monthlyAllowanceMicrousd: null, isDemo: false,
    });
    for (const [i, rule] of task.approvedRules.entries()) {
      const rec = await callOk(rt, 'relay/v1/memory.create', {
        idempotencyKey: `eval-rule-${String(i)}-${name}`.slice(0, 64), projectId: project.id, type: 'user_rule', title: rule.title, content: rule.content, scope: { roles: 'all' },
      });
      if (rec.status !== 'approved') await callOk(rt, 'relay/v1/memory.approve', { suggestionId: rec.id, expectedRevision: rec.currentRevision });
    }
    const workflowIds = new Map(rt.db.repos.workflows.listWorkflows().map((w) => [w.slug, w.id]));
    return { rt, projectId: project.id, workflowIds, userDataDir };
  } catch (e) {
    await rt.dispose();
    throw e;
  }
}

function workflowOf(ws: { workflowIds: Map<string, WorkflowId> }, config: EvalConfig): WorkflowId {
  const id = ws.workflowIds.get(SLUG[config]);
  if (id === undefined) throw new Error(`workflow ${SLUG[config]} not seeded`);
  return id;
}

/** "review, plan, implement, verify (+ up to 2 × implement, verify)". */
function describeSteps(rt: Runtime, workflowId: WorkflowId): { text: string; maxModelCalls: number } {
  const v = rt.db.repos.workflows.getVersion(workflowId, 1);
  if (v === undefined) throw new Error('workflow version 1 missing');
  const spec = v.spec;
  const model = spec.steps.filter((s) => s.kind === 'model').map((s) => s.id);
  const cycles = spec.limits.maxRevisionCycles ?? 0;
  const repeat = spec.revisionPolicy.repeatSteps;
  const ceiling = spec.limits.maxAttempts ?? model.length;
  const text = `${model.join(', ')}${cycles > 0 ? ` (+ up to ${String(cycles)} × ${repeat.join(', ')})` : ''}; attempt ceiling ${String(ceiling)}`;
  return { text, maxModelCalls: ceiling };
}

async function dryRun(plan: readonly PlannedRun[], capMicrousd: number | null): Promise<number> {
  const scratch = await makeScratchDir('relay-eval-dry-');
  try {
    let total = 0;
    process.stdout.write(`\nPlanned runs (${String(plan.length)}), in randomized order. FAKE provider preflight only: no request is sent, nothing is spent.\n\n`);
    process.stdout.write('  #   config        task                          model steps / ceiling                                         N (1st)   upper bound\n');
    const perTask = new Map<string, { L: number; N: number; steps: string }>();
    for (const r of plan) {
      const key = `${r.config}|${r.task.id}`;
      let info = perTask.get(key);
      if (info === undefined) {
        const ws = await openWorkspace(scratch, `${r.config}-${r.task.id}`, 'fake', r.task);
        try {
          const workflowId = workflowOf(ws, r.config);
          const pre = await callOk(ws.rt, 'relay/v1/runs.preflight', {
            projectId: ws.projectId, workflowId, workflowVersion: 1, goal: r.task.goal, input: { kind: 'files', relPaths: [...r.task.input.relPaths] },
          });
          if (pre.issues.length > 0) throw new Error(`${r.task.id}: preflight issues ${JSON.stringify(pre.issues)}`);
          info = { L: pre.budget.L, N: pre.firstReservation.N, steps: describeSteps(ws.rt, workflowId).text };
          perTask.set(key, info);
        } finally {
          await ws.rt.dispose();
        }
      }
      total += info.L;
      process.stdout.write(`  ${String(r.order).padStart(3)} ${r.config.padEnd(13)} ${`${r.task.id} #${String(r.repeat)}`.padEnd(29)} ${info.steps.padEnd(61)} ${usd(info.N).padStart(8)}  ${usd(info.L).padStart(9)}\n`);
    }
    process.stdout.write(
      [
        '',
        `Estimated upper bound: ${usd(total)} for ${String(plan.length)} run(s) — each run is capped by its run budget (the engine refuses any reservation past it).`,
        'This is a ceiling, not a forecast. Provider bills can still differ from tracked usage (unknown outcomes, price changes), see docs/release/known-limitations.md.',
        capMicrousd === null
          ? 'Live mode would also need --cap-usd; runs beyond the cap are not started.'
          : `With --cap-usd ${usd(capMicrousd)}: ${String(Math.max(0, countWithinCap(plan.map((p) => perTask.get(`${p.config}|${p.task.id}`)?.L ?? 0), capMicrousd)))} of ${String(plan.length)} run(s) would start before the cap stops the evaluation.`,
        'Dry run complete: 0 requests sent, $0.00 spent.',
        '',
      ].join('\n'),
    );
    return 0;
  } finally {
    await cleanupScratchDirs();
  }
}

/** How many runs start, in order, before the next run's budget would cross the cap (the worst case: each spends L). */
function countWithinCap(budgets: readonly number[], cap: number): number {
  let spent = 0;
  let n = 0;
  for (const b of budgets) {
    if (spent + b > cap) break;
    spent += b;
    n += 1;
  }
  return n;
}

const STOP_STATUSES: readonly RunStatus[] = ['completed', 'incomplete', 'failed', 'cancelled'];

async function liveRun(r: PlannedRun, scratch: string, remainingMicrousd: number, outDir: string): Promise<EvalResult> {
  const startedAt = new Date();
  const t0 = Date.now();
  const ws = await openWorkspace(scratch, `${r.config}-${r.task.id}-${String(r.repeat)}`, 'live', r.task);
  let runId: RunId | null = null;
  let stopReason: string | null = null;
  let approvals = 0;
  try {
    const workflowId = workflowOf(ws, r.config);
    const pre = await callOk(ws.rt, 'relay/v1/runs.preflight', {
      projectId: ws.projectId, workflowId, workflowVersion: 1, goal: r.task.goal, input: { kind: 'files', relPaths: [...r.task.input.relPaths] },
    });
    const budget = Math.min(pre.budget.L, remainingMicrousd);
    await ws.rt.engine.start();
    const started = await callOk(ws.rt, 'relay/v1/runs.start', {
      idempotencyKey: `eval-${r.config}-${r.task.id}-${String(r.repeat)}`.slice(0, 64).padEnd(10, '0'), projectId: ws.projectId, workflowId, workflowVersion: 1,
      goal: r.task.goal, input: { kind: 'files', relPaths: [...r.task.input.relPaths] }, limitOverrides: { budgetMicrousd: microusd(budget) },
    });
    const id = started.runId;
    runId = id;
    const deadline = Date.now() + RUN_TIMEOUT_MS;
    for (;;) {
      const run = ws.rt.db.repos.runs.get(id);
      if (STOP_STATUSES.includes(run.status)) break;
      if (run.status === 'awaiting_approval') {
        // Headless evaluation: the harness approves exactly what the UI would show (recorded in the result).
        const d = await callOk(ws.rt, 'relay/v1/runs.get', { runId: id });
        const a = d.pendingApproval;
        if (a !== null) {
          await callOk(ws.rt, 'relay/v1/approvals.decide', { idempotencyKey: `eval-approve-${id}-${String(approvals)}`.slice(0, 64), approvalId: a.id, planHash: a.planHash, contextHash: a.contextHash, decision: 'approved' });
          approvals += 1;
        }
      } else if (run.status === 'paused' || run.status === 'interrupted' || Date.now() > deadline) {
        stopReason = Date.now() > deadline ? 'timeout'
          : run.pauseReason === 'budget_run' && budget < pre.budget.L ? 'cost_cap'
          : `paused:${run.pauseReason ?? run.status}`;
        await callOk(ws.rt, 'relay/v1/runs.cancel', { runId: id });
      }
      await sleep(500);
    }
  } catch (e) {
    stopReason = `harness_error:${e instanceof Error ? e.message.slice(0, 200) : 'unknown'}`;
    if (runId !== null) await ws.rt.engine.handle('relay/v1/runs.cancel', { runId }).catch(() => undefined);
  }
  try {
    const copied: string[] = [];
    let costs: EvalResult['costs'] = { settledReportedMicrousd: 0, settledCalculatedMicrousd: 0, settledEstimatedMicrousd: 0, unknownMicrousd: 0 };
    let status: EvalResult['status'] = 'not_started';
    let pauseReason: string | null = null;
    let steps: EvalResult['steps'] = [];
    if (runId !== null) {
      const d = await callOk(ws.rt, 'relay/v1/runs.get', { runId });
      status = d.status;
      pauseReason = d.pauseReason;
      costs = { settledReportedMicrousd: d.cost.settledReported, settledCalculatedMicrousd: d.cost.settledCalculated, settledEstimatedMicrousd: d.cost.settledEstimated, unknownMicrousd: d.cost.unknown };
      steps = d.steps.map((s) => ({ stepKey: s.stepKey, state: s.state, providerId: s.providerId, modelId: s.modelId }));
      const artDir = join(outDir, r.config, `${r.task.id}-${String(r.repeat)}.artifacts`);
      for (const a of ws.rt.db.repos.artifacts.listForRun(runId, ['plan', 'patch', 'review', 'findings', 'report'])) {
        const src = join(ws.userDataDir, a.relPath);
        if (!(await exists(src))) continue;
        const name = `${a.kind}-${a.id}.json`;
        await mkdir(artDir, { recursive: true });
        await cp(src, join(artDir, name));
        copied.push(join(r.config, `${r.task.id}-${String(r.repeat)}.artifacts`, name));
      }
    }
    return {
      schemaVersion: 1, config: r.config, taskId: r.task.id, repeat: r.repeat, order: r.order, runId, status, pauseReason, stopReason, costs,
      elapsedMs: Date.now() - t0, startedAt: startedAt.toISOString(), steps, approvals, artifacts: copied,
    };
  } finally {
    await ws.rt.dispose();
  }
}

const trackedSpend = (c: EvalResult['costs']): number => c.settledReportedMicrousd + c.settledCalculatedMicrousd + c.settledEstimatedMicrousd + c.unknownMicrousd;

function csvRow(cells: readonly (string | number | null)[]): string {
  return cells.map((c) => {
    const s = c === null ? '' : String(c);
    return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  }).join(',');
}

async function live(plan: readonly PlannedRun[], capMicrousd: number, outDir: string): Promise<number> {
  const needed = new Set<string>(['anthropic']); // the default profiles (seed.ts) all use Anthropic models
  for (const p of needed) {
    const name = KEY_ENV[p] ?? '';
    if ((process.env[name] ?? '').trim() === '') {
      process.stderr.write(`evaluate: ${name} is not set in this process's environment; refusing to start\n`);
      return 2;
    }
  }
  const scratch = await makeScratchDir('relay-eval-live-');
  const results: EvalResult[] = [];
  let spent = 0;
  try {
    for (const r of plan) {
      const remaining = capMicrousd - spent;
      if (remaining <= 0) {
        results.push({ schemaVersion: 1, config: r.config, taskId: r.task.id, repeat: r.repeat, order: r.order, runId: null, status: 'not_started', pauseReason: null,
          stopReason: 'cost_cap', costs: { settledReportedMicrousd: 0, settledCalculatedMicrousd: 0, settledEstimatedMicrousd: 0, unknownMicrousd: 0 }, elapsedMs: 0,
          startedAt: new Date().toISOString(), steps: [], approvals: 0, artifacts: [] });
        continue;
      }
      process.stdout.write(`run ${String(r.order)}/${String(plan.length)}: ${r.config} ${r.task.id} #${String(r.repeat)} (remaining cap ${usd(remaining)})\n`);
      const res = await liveRun(r, scratch, remaining, outDir);
      spent += trackedSpend(res.costs);
      results.push(res);
      await mkdir(join(outDir, r.config), { recursive: true });
      await writeFile(join(outDir, r.config, `${r.task.id}-${String(r.repeat)}.json`), `${JSON.stringify(res, null, 2)}\n`);
      process.stdout.write(`  → ${res.status}${res.stopReason === null ? '' : ` (${res.stopReason})`}, tracked ${usd(trackedSpend(res.costs))}, cumulative ${usd(spent)}\n`);
    }
    for (const res of results.filter((x) => x.status === 'not_started')) {
      await mkdir(join(outDir, res.config), { recursive: true });
      await writeFile(join(outDir, res.config, `${res.taskId}-${String(res.repeat)}.json`), `${JSON.stringify(res, null, 2)}\n`);
    }
    const header = ['order', 'config', 'task', 'repeat', 'run_id', 'status', 'stop_reason', 'reported_usd', 'calculated_usd', 'estimated_usd', 'unknown_usd', 'elapsed_s'];
    const rows = results.map((x) => csvRow([x.order, x.config, x.taskId, x.repeat, x.runId, x.status, x.stopReason,
      x.costs.settledReportedMicrousd / 1e6, x.costs.settledCalculatedMicrousd / 1e6, x.costs.settledEstimatedMicrousd / 1e6, x.costs.unknownMicrousd / 1e6, Math.round(x.elapsedMs / 1000)]));
    await writeFile(join(outDir, 'summary.csv'), `${[header.join(','), ...rows].join('\n')}\n`);
    const scores = join(outDir, 'scores.csv');
    if (!(await exists(scores))) {
      // A blank template for the founder. The harness never fills a score (§17.4, §7.7).
      const sHeader = 'config,task,repeat,accepted,correctness,coverage,unintended_changes,explanation,review_minutes,setup_minutes,notes';
      await writeFile(scores, `${[sHeader, ...results.map((x) => csvRow([x.config, x.taskId, x.repeat, '', '', '', '', '', '', '', '']))].join('\n')}\n`);
    }
    process.stdout.write(`\nResults: ${outDir}\nTracked total ${usd(spent)} (tracked usage, not the provider bill). Score the runs by hand in scores.csv (tests/evaluations/rubric.md).\n`);
    return 0;
  } finally {
    await cleanupScratchDirs();
  }
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      config: { type: 'string', default: 'both' },
      tasks: { type: 'string', default: 'all' },
      repeat: { type: 'string', default: '1' },
      seed: { type: 'string', default: '17' },
      'dry-run': { type: 'boolean', default: false },
      'cap-usd': { type: 'string' },
      out: { type: 'string' },
    },
    strict: true,
  });
  const configs: EvalConfig[] = values.config === 'both' ? ['relay', 'single-agent'] : values.config === 'relay' || values.config === 'single-agent' ? [values.config] : [];
  if (configs.length === 0) {
    process.stderr.write('evaluate: --config must be relay, single-agent, or both\n');
    return 2;
  }
  const repeat = Number(values.repeat);
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > MAX_REPEAT) {
    process.stderr.write(`evaluate: --repeat must be an integer 1–${String(MAX_REPEAT)}\n`);
    return 2;
  }
  let capMicrousd: number | null = null;
  if (values['cap-usd'] !== undefined) {
    const cap = Number(values['cap-usd']);
    if (!Number.isFinite(cap) || cap <= 0) {
      process.stderr.write('evaluate: --cap-usd must be a positive dollar amount\n');
      return 2;
    }
    capMicrousd = Math.floor(cap * 1_000_000);
  }

  const { tasks, problems } = await loadTasks(TASKS_DIR, SAMPLE);
  if (problems.length > 0) {
    process.stderr.write(`evaluate: ${String(problems.length)} task file problem(s):\n${problems.map((p) => `  ${p}`).join('\n')}\n`);
    return 1;
  }
  const { selected, unknown } = selectTasks(tasks, values.tasks);
  if (unknown.length > 0 || selected.length === 0) {
    process.stderr.write(`evaluate: unknown task(s): ${unknown.join(', ') || '(none selected)'}\n`);
    return 2;
  }
  process.stdout.write(`Validated ${String(tasks.length)} task file(s); selected ${selected.map((t) => t.id).join(', ')}.\n`);

  const raw: Omit<PlannedRun, 'order'>[] = [];
  for (const task of selected) for (let n = 1; n <= repeat; n += 1) for (const config of configs) raw.push({ config, task, repeat: n });
  const plan = shuffle(raw, Number(values.seed)).map((p, i) => ({ ...p, order: i + 1 }));

  if (values['dry-run']) return dryRun(plan, capMicrousd);

  if (process.env['RELAY_LIVE_TESTS'] !== '1' || capMicrousd === null) {
    process.stderr.write('evaluate: live mode spends real money and needs BOTH RELAY_LIVE_TESTS=1 and --cap-usd <dollars>. Use --dry-run to plan without spending.\n');
    return 2;
  }
  const outDir = resolve(values.out ?? join(RESULTS_DIR, new Date().toISOString().slice(0, 10)));
  if (await exists(join(outDir, 'summary.csv'))) {
    process.stderr.write(`evaluate: ${outDir} already has results; pass --out <new dir>\n`);
    return 2;
  }
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, 'config.json'), `${JSON.stringify({ configs, tasks: selected.map((t) => t.id), repeat, seed: Number(values.seed), capUsd: capMicrousd / 1e6,
    startedAt: new Date().toISOString(), taskFiles: Object.fromEntries(await Promise.all(selected.map(async (t) => [t.id, await readFile(join(TASKS_DIR, `${t.id}.json`), 'utf8')] as const))) }, null, 2)}\n`);
  return live(plan, capMicrousd, outDir);
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    process.stderr.write(`evaluate failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
    process.exitCode = 1;
  },
);
