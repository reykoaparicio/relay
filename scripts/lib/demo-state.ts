// 13 §M3: the four prepared demo states (§22.2) — how the fake-mode generator creates them and how demo-verify and
// demo-snapshot assert them. Everything goes through `createRuntime` (06 F16) and the runner IPC handlers.
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { microusd } from '@relay/contracts';
import type { ProjectId, ProviderId, RunId, WorkflowId } from '@relay/contracts';
import type { Runtime } from '@relay/engine';
import { callOk, memoryLogger, openFakeRuntime, waitUntil } from './demo-runtime.js';

/** Repo root (scripts/lib → ../../). */
export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** The demo project (mirrors apps/desktop/src/main/samples.ts: name, $20 allowance, three BYOK providers). */
export const DEMO_PROJECT = {
  name: 'Sample API',
  monthlyAllowanceMicrousd: 20_000_000,
  allowedProviderIds: ['anthropic', 'openai', 'gemini'] as readonly ProviderId[],
};

/** The approved rule shown at §22.2 0:00 ("Context persists"). */
export const DEMO_RULE = {
  title: 'Keep the public response format',
  content: 'Every endpoint answers { data } or { error: { code, message } }. Never add, rename, or remove top-level response fields, and never return an empty body.',
};

/** Files every prepared run reads. */
export const DEMO_REL_PATHS: readonly string[] = [
  'src/handlers/user.ts',
  'src/handlers/orders.ts',
  'src/lib/format.ts',
  'src/lib/validate.ts',
  'src/errors.ts',
  'src/handlers/health.ts',
];

/** Goals of the prepared runs (labels only; the demo never presents their fake outputs as live model results). */
export const DEMO_GOALS = {
  completed: 'Review the user and order handlers for input-handling and error-handling problems, and propose a fix that keeps the public response format.',
  budgetBlocked: 'Same review with a deliberately tiny run budget (prepared to show budget enforcement).',
  interrupted: 'Review the handlers and propose a fix (prepared: interrupted after the plan step to show recovery).',
} as const;

/** Ids of the prepared state. */
export interface PreparedIds {
  readonly projectId: ProjectId;
  readonly completedRunId: RunId;
  readonly budgetRunId: RunId;
  readonly interruptedRunId: RunId;
}

function firstWorkflowId(rt: Runtime): WorkflowId {
  const wf = rt.db.repos.workflows.listWorkflows().find((w) => w.slug === 'review-propose-fix') ?? rt.db.repos.workflows.listWorkflows()[0];
  if (wf === undefined) throw new Error('no seeded workflow');
  return wf.id;
}

const runStatus = (rt: Runtime, id: RunId): string => rt.db.repos.runs.get(id).status;

/**
 * Builds the four prepared states in a fresh fake-mode userData dir (13 §M3): the sample project with 1 approved rule;
 * a completed run with its report; a budget-blocked run (paused, budget_run, no provider call); and an `interrupted`
 * run whose plan step committed before a simulated crash (a real child process exiting 137 at `afterStepCommit@plan`,
 * the 06 F13 crash hook), recovered by the next `engine.start()`.
 */
export async function prepareFakeDemo(userDataDir: string, sampleRoot: string, sampleDisplayPath: string): Promise<PreparedIds> {
  const logger = memoryLogger();
  let rt = await openFakeRuntime(userDataDir, { logger });
  let ids: Omit<PreparedIds, 'interruptedRunId'>;
  let workflowId: WorkflowId;
  try {
    const project = await callOk(rt, 'relay/v1/projects.createFromRoot', {
      idempotencyKey: 'demo-prepare-project-0001', rootRealpath: sampleRoot, rootDisplayPath: sampleDisplayPath, name: DEMO_PROJECT.name,
      exclusions: [], allowedProviderIds: [...DEMO_PROJECT.allowedProviderIds], monthlyAllowanceMicrousd: microusd(DEMO_PROJECT.monthlyAllowanceMicrousd), isDemo: true,
    });
    const rule = await callOk(rt, 'relay/v1/memory.create', {
      idempotencyKey: 'demo-prepare-rule-00001', projectId: project.id, type: 'user_rule', title: DEMO_RULE.title, content: DEMO_RULE.content,
      scope: { roles: 'all' }, pinned: true,
    });
    if (rule.status !== 'approved') {
      await callOk(rt, 'relay/v1/memory.approve', { suggestionId: rule.id, expectedRevision: rule.currentRevision });
    }
    workflowId = firstWorkflowId(rt);
    await rt.engine.start();

    // 2. Completed run with report.
    const completed = await callOk(rt, 'relay/v1/runs.start', {
      idempotencyKey: 'demo-prepare-run-completed', projectId: project.id, workflowId, workflowVersion: 1, goal: DEMO_GOALS.completed,
      input: { kind: 'files', relPaths: [...DEMO_REL_PATHS] },
    });
    const live = rt;
    await waitUntil(() => runStatus(live, completed.runId) === 'awaiting_approval', 'completed run: awaiting_approval');
    const detail = await callOk(rt, 'relay/v1/runs.get', { runId: completed.runId });
    const a = detail.pendingApproval;
    if (a === null) throw new Error('completed run: no pending approval');
    await callOk(rt, 'relay/v1/approvals.decide', {
      idempotencyKey: 'demo-prepare-approve-0001', approvalId: a.id, planHash: a.planHash, contextHash: a.contextHash, decision: 'approved',
    });
    await waitUntil(() => runStatus(live, completed.runId) === 'completed', 'completed run: completed');
    await waitUntil(() => live.db.repos.artifacts.listForRun(completed.runId, ['report']).length > 0, 'completed run: report');

    // 3. Budget-blocked run: a run budget below the first reservation N.
    const pre = await callOk(rt, 'relay/v1/runs.preflight', {
      projectId: project.id, workflowId, workflowVersion: 1, goal: DEMO_GOALS.budgetBlocked, input: { kind: 'files', relPaths: [...DEMO_REL_PATHS] },
    });
    const tiny = Math.max(0, Math.floor(pre.firstReservation.N / 2));
    const blocked = await callOk(rt, 'relay/v1/runs.start', {
      idempotencyKey: 'demo-prepare-run-budget01', projectId: project.id, workflowId, workflowVersion: 1, goal: DEMO_GOALS.budgetBlocked,
      input: { kind: 'files', relPaths: [...DEMO_REL_PATHS] }, limitOverrides: { budgetMicrousd: microusd(tiny) },
    });
    await waitUntil(() => live.db.repos.runs.get(blocked.runId).pauseReason === 'budget_run', 'budget run: paused(budget_run)');
    ids = { projectId: project.id, completedRunId: completed.runId, budgetRunId: blocked.runId };
  } catch (e) {
    process.stderr.write(`${logger.lines.slice(-30).join('\n')}\n`);
    throw e;
  } finally {
    await rt.dispose();
  }

  // 4. Interrupted run: a real child process crashes right after the plan step commits.
  const child = await runCrashChild({ userDataDir, projectId: ids.projectId, workflowId, goal: DEMO_GOALS.interrupted, relPaths: DEMO_REL_PATHS });
  if (child.code !== 137) throw new Error(`crash child exited ${String(child.code)} (wanted 137)\n${child.stderr}`);
  rt = await openFakeRuntime(userDataDir, { logger });
  let interruptedRunId: RunId | undefined;
  try {
    // Found by goal: the child's stdout may not flush before its exit(137).
    const runs = await callOk(rt, 'relay/v1/runs.list', { projectId: ids.projectId, sort: 'created_asc' });
    interruptedRunId = runs.items.find((r) => r.goal === DEMO_GOALS.interrupted)?.id;
    if (interruptedRunId === undefined) throw new Error(`crash child started no run\n${child.stderr}`);
    const runId = interruptedRunId;
    await rt.engine.start(); // recovery: running → interrupted (RUNNER_LOST)
    const live = rt;
    await waitUntil(() => runStatus(live, runId) === 'interrupted', 'interrupted run: interrupted');
  } finally {
    await rt.dispose();
  }
  return { ...ids, interruptedRunId };
}

/** Runs scripts/lib/demo-crash-child.ts with RELAY_CRASH_AT=afterStepCommit@plan (06 F13 grammar). */
function runCrashChild(job: { userDataDir: string; projectId: ProjectId; workflowId: WorkflowId; goal: string; relPaths: readonly string[] }): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const env: NodeJS.ProcessEnv = { RELAY_E2E: '1', RELAY_CRASH_AT: 'afterStepCommit@plan' };
  for (const k of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'TZ']) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  const childPath = fileURLToPath(new URL('./demo-crash-child.ts', import.meta.url));
  const proc = spawn(process.execPath, ['--import', 'tsx', '--conditions=development', childPath, JSON.stringify(job)], { cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  proc.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
  proc.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
  return new Promise((resolve, reject) => {
    const timer = globalThis.setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error('crash child timed out'));
    }, 60_000);
    proc.on('error', reject);
    proc.on('close', (code) => {
      globalThis.clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/** One verification line. `required` failures fail the script; `info` lines are printed only. */
export interface Check {
  readonly label: string;
  readonly ok: boolean;
  readonly detail: string;
  readonly level: 'required' | 'info';
}

/**
 * Asserts the prepared demo states through the runner IPC (`projects.*`, `memory.list`, `runs.*`) of a fake-mode
 * runtime over `userDataDir`, without starting the engine (no recovery, no dispatch).
 */
export async function verifyDemoState(rt: Runtime, userDataDir: string, o: { checkProjectRoot: boolean }): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (label: string, ok: boolean, detail: string, level: Check['level'] = 'required'): void => {
    checks.push({ label, ok, detail, level });
  };
  const projects = (await callOk(rt, 'relay/v1/projects.list', {})).filter((p) => p.isDemo);
  add('Sample project present (exactly one demo project)', projects.length === 1, `${String(projects.length)} demo project(s)`);
  const project = projects[0];
  if (project === undefined) return checks;

  if (o.checkProjectRoot) {
    const root = rt.db.repos.projects.getWithRoot(project.id).rootRealpath;
    const opened = await rt.projectFs.openRoot(root);
    add('Sample project folder exists and opens', opened.ok, opened.ok ? project.rootDisplayPath : `root not usable: ${opened.error.code}`);
  }

  const rules = await callOk(rt, 'relay/v1/memory.list', { projectId: project.id, status: ['approved'], type: ['user_rule'] });
  add('1 approved project rule (§22.2 0:00)', rules.length >= 1, `${String(rules.length)} approved user rule(s)`);

  const runs = (await callOk(rt, 'relay/v1/runs.list', { projectId: project.id, sort: 'created_asc' })).items;

  const completed = runs.find((r) => r.status === 'completed');
  let reportOk = false;
  let reportDetail = 'no completed run';
  if (completed !== undefined) {
    const d = await callOk(rt, 'relay/v1/runs.get', { runId: completed.id });
    const report = rt.db.repos.artifacts.listForRun(completed.id, ['report'])[0];
    const onDisk = report === undefined ? false : await access(join(userDataDir, report.relPath)).then(() => true, () => false);
    reportOk = d.reportArtifactId !== null && onDisk;
    reportDetail = `run ${completed.id}: report ${d.reportArtifactId === null ? 'missing' : onDisk ? 'present' : 'file missing'}`;
  }
  add('Completed run with report (fallback for 1:00–2:40)', reportOk, reportDetail);

  const blocked = runs.find((r) => r.status === 'paused' && r.pauseReason === 'budget_run');
  let blockedDetail = 'no paused(budget_run) run';
  let blockedOk = false;
  if (blocked !== undefined) {
    const d = await callOk(rt, 'relay/v1/runs.get', { runId: blocked.id });
    const dispatched = rt.db.repos.attempts.listForRun(blocked.id).filter((x) => x.state !== 'failed_before_dispatch').length;
    blockedOk = d.statusDetail?.code === 'BUDGET_BLOCKED' && dispatched === 0;
    blockedDetail = `run ${blocked.id}: ${d.statusDetail?.code ?? 'no detail'}, ${String(dispatched)} provider request(s)`;
  }
  add('Budget-blocked run (2:40–3:10)', blockedOk, blockedDetail);

  const interrupted = runs.find((r) => r.status === 'interrupted');
  let intDetail = 'no interrupted run';
  let intOk = false;
  if (interrupted !== undefined) {
    const latest = new Map(rt.db.repos.steps.latestPerStepKey(interrupted.id).map((s) => [s.stepKey as string, s.state as string]));
    intOk = latest.get('plan') === 'succeeded' && latest.get('approve') !== 'succeeded';
    intDetail = `run ${interrupted.id}: plan ${latest.get('plan') ?? 'absent'}, approve ${latest.get('approve') ?? 'absent'}`;
  }
  add('Interrupted run checkpointed after Plan (3:10–3:40)', intOk, intDetail);
  return checks;
}

/** Prints the checks as a checklist; returns true when every required check passed. */
export function printChecklist(title: string, checks: readonly Check[]): boolean {
  process.stdout.write(`\n${title}\n`);
  for (const c of checks) {
    const mark = c.ok ? '[ok]  ' : c.level === 'required' ? '[FAIL]' : '[warn]';
    process.stdout.write(`  ${mark} ${c.label} — ${c.detail}\n`);
  }
  return checks.every((c) => c.ok || c.level !== 'required');
}
