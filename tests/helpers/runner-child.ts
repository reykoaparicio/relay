/**
 * Crash-matrix child process (11 §K3/K4). Forked by `crash-harness.ts` with
 * `execArgv: ['--import', 'tsx', '--conditions=development']`. It composes exactly what the desktop runner composes
 * (`createRuntime` from @relay/engine, fake provider, JSONL call log in userData) and, when `RELAY_E2E=1` and
 * `RELAY_CRASH_AT=<hook>@<stepKey>[#n]` are set, wires the parsed crash hook to `process.exit(137)`.
 *
 * Protocol: the first IPC message is the {@link ChildJob}; the child answers with {@link ChildMessage}s and exits 0 once
 * the run reached one of `job.until` (or stays alive when `job.stayAlive`, for the SIGKILL row).
 */
import './no-network.js';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ok } from '@relay/contracts';
import type { AttemptId, ModelCapabilities, ProjectId, RecoveryDecision, RunId, RunStatus } from '@relay/contracts';
import { createRuntime, crashHooksFromEnv } from '@relay/engine';
import type { Logger } from '@relay/engine';
import { createJsonlCallLog } from '@relay/providers';
import type { FakeScenario } from '@relay/providers';

/** What the child should do after starting the engine (recovery always runs in `engine.start()`). */
export type ChildAction =
  | { readonly kind: 'start'; readonly projectRoot: string; readonly relPaths: readonly string[]; readonly goal: string }
  | { readonly kind: 'recover' }
  | { readonly kind: 'resume'; readonly decision: RecoveryDecision }
  | { readonly kind: 'approve' }
  | { readonly kind: 'decideUnknown'; readonly attemptId: AttemptId; readonly decision: 'retry_acknowledging_charge' | 'mark_failed_keep_liability' | 'accept_estimated_charge' }
  /** Decision 1: `runs.retryStep` on the latest row of `stepKey` ("retry, may incur another charge"). */
  | { readonly kind: 'retryStep'; readonly stepKey: string };

export interface ChildJob {
  readonly userDataDir: string;
  readonly scenario?: string | FakeScenario;
  readonly fakeCapabilityOverrides?: Partial<ModelCapabilities>;
  readonly fakeExtraFixtures?: Record<string, unknown>;
  readonly action: ChildAction;
  /** Required for every action but `start`. */
  readonly runId?: RunId;
  /** Report and exit once the run is in one of these statuses. */
  readonly until: readonly RunStatus[];
  /** Also wait until no attempt of the run is `unknown` (F9b reconcile finished). */
  readonly untilNoUnknown?: boolean;
  /** Keep the process alive after reporting (the parent SIGKILLs it). */
  readonly stayAlive?: boolean;
  readonly timeoutMs?: number;
}

export type ChildMessage =
  | { readonly type: 'started'; readonly runId: RunId; readonly projectId: ProjectId }
  | { readonly type: 'acted'; readonly ok: boolean; readonly code?: string; readonly status?: string }
  | { readonly type: 'status'; readonly runId: RunId; readonly status: RunStatus; readonly pauseReason: string | null }
  | { readonly type: 'error'; readonly message: string };

function send(m: ChildMessage): Promise<void> {
  return new Promise((resolve) => {
    if (process.send === undefined) {
      resolve();
      return;
    }
    process.send(m, () => {
      resolve();
    });
  });
}

function fileLogger(path: string): Logger {
  mkdirSync(join(path, '..'), { recursive: true });
  const at = (level: string) => (event: string, fields?: Readonly<Record<string, unknown>>) => {
    appendFileSync(path, `${JSON.stringify({ ts: Date.now(), pid: process.pid, level, event, ...fields })}\n`, 'utf8');
  };
  return { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => globalThis.setTimeout(resolve, ms));

async function runJob(job: ChildJob): Promise<void> {
  const hooks = crashHooksFromEnv(process.env);
  const runtime = await createRuntime({
    userDataDir: job.userDataDir,
    providerMode: 'fake',
    fakeScenario: job.scenario ?? 'happy-path',
    ...(job.fakeCapabilityOverrides === undefined ? {} : { fakeCapabilityOverrides: job.fakeCapabilityOverrides }),
    ...(job.fakeExtraFixtures === undefined ? {} : { fakeExtraFixtures: job.fakeExtraFixtures }),
    credentials: { resolve: () => Promise.resolve(ok('test-key-0000000000000000')) },
    callLog: createJsonlCallLog(join(job.userDataDir, 'fake-call-log.jsonl')),
    logger: fileLogger(join(job.userDataDir, 'logs', 'runner-child.jsonl')),
    ...(hooks === undefined ? {} : { hooks }),
    idleMs: 20,
  });
  const { engine, db } = runtime;
  let runId = job.runId;
  const action = job.action;
  if (action.kind === 'start') {
    const project = await engine.handle('relay/v1/projects.createFromRoot', {
      idempotencyKey: 'crash-child-project-01', rootRealpath: action.projectRoot, rootDisplayPath: '~/sample-api', name: 'Sample API',
      exclusions: [], allowedProviderIds: ['anthropic', 'openai', 'gemini', 'fake'], monthlyAllowanceMicrousd: null, isDemo: false,
    });
    if (!project.ok) throw new Error(`createFromRoot: ${project.error.code}`);
    // The queued-run checks read the credential-ref repo (never the key): record one per provider, like the app does on connect.
    for (const providerId of ['anthropic', 'openai', 'gemini', 'fake'] as const) {
      const ref = await engine.handle('relay/v1/providers.recordCredentialRef', { providerId, storageMode: 'session', vaultFile: null, redactedLabel: 'sk-…test' });
      if (!ref.ok) throw new Error(`recordCredentialRef: ${ref.error.code}`);
    }
    const workflow = db.repos.workflows.listWorkflows()[0];
    if (workflow === undefined) throw new Error('no seeded workflow');
    const started = await engine.handle('relay/v1/runs.start', {
      idempotencyKey: 'crash-child-run-0001', projectId: project.data.id, workflowId: workflow.id, workflowVersion: 1, goal: action.goal,
      input: { kind: 'files', relPaths: [...action.relPaths] },
    });
    if (!started.ok) throw new Error(`runs.start: ${started.error.code} ${JSON.stringify(started.error.details ?? null)}`);
    runId = started.data.runId;
    await send({ type: 'started', runId, projectId: project.data.id });
  }
  if (runId === undefined) throw new Error('job.runId is required');
  await engine.start(); // lease → recovery → loop

  if (action.kind === 'resume') {
    const res = await engine.handle('relay/v1/runs.resume', { idempotencyKey: `crash-child-resume-${String(Date.now())}`, runId, decision: action.decision });
    await send(res.ok ? { type: 'acted', ok: true, status: res.data.status } : { type: 'acted', ok: false, code: res.error.code });
  } else if (action.kind === 'approve') {
    const detail = await engine.handle('relay/v1/runs.get', { runId });
    if (!detail.ok || detail.data.pendingApproval === null) throw new Error('approve: no pending approval');
    const a = detail.data.pendingApproval;
    const res = await engine.handle('relay/v1/approvals.decide', { idempotencyKey: `crash-child-approve-${String(Date.now())}`, approvalId: a.id,
      planHash: a.planHash, contextHash: a.contextHash, decision: 'approved' });
    await send(res.ok ? { type: 'acted', ok: true, status: res.data.runStatus } : { type: 'acted', ok: false, code: res.error.code });
  } else if (action.kind === 'retryStep') {
    const step = db.repos.steps.latestPerStepKey(runId).find((s) => s.stepKey === action.stepKey);
    if (step === undefined) throw new Error(`retryStep: no step ${action.stepKey}`);
    const res = await engine.handle('relay/v1/runs.retryStep', { idempotencyKey: `crash-child-retry-${String(Date.now())}`, runId, stepId: step.id });
    await send(res.ok ? { type: 'acted', ok: true, status: res.data.status } : { type: 'acted', ok: false, code: res.error.code });
  } else if (action.kind === 'decideUnknown') {
    const res = await engine.handle('relay/v1/runs.decideUnknown', { idempotencyKey: `crash-child-unknown-${String(Date.now())}`, runId,
      attemptId: action.attemptId, decision: action.decision });
    await send(res.ok ? { type: 'acted', ok: true, status: res.data.status } : { type: 'acted', ok: false, code: res.error.code });
  }

  const deadline = Date.now() + (job.timeoutMs ?? 20_000);
  for (;;) {
    const run = db.repos.runs.get(runId);
    const settled = job.untilNoUnknown !== true || !db.repos.attempts.listForRun(runId).some((a) => a.state === 'unknown');
    if (job.until.includes(run.status) && settled) {
      await send({ type: 'status', runId, status: run.status, pauseReason: run.pauseReason });
      break;
    }
    if (Date.now() > deadline) throw new Error(`child: run ${runId} stuck in ${run.status}(${String(run.pauseReason)}), wanted ${job.until.join('|')}`);
    await sleep(10);
  }
  if (job.stayAlive === true) {
    await new Promise<never>(() => undefined); // parked until the parent SIGKILLs us
  }
  await runtime.dispose();
}

process.once('message', (raw) => {
  runJob(raw as ChildJob).then(
    () => {
      process.disconnect();
      process.exit(0);
    },
    async (e: unknown) => {
      await send({ type: 'error', message: e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e) });
      process.exit(1);
    },
  );
});
