// 13 §M3 helper (fake mode only): started by demo-state.ts as a separate Node process with RELAY_E2E=1 and
// RELAY_CRASH_AT=afterStepCommit@plan. It starts one run on the prepared demo project and exits 137 inside the
// crash hook right after the plan step commits (06 F13), leaving a `running` run that the next engine.start()
// recovers as `interrupted`. The parent finds the run by its goal.
import type { ProjectId, WorkflowId } from '@relay/contracts';
import { crashHooksFromEnv } from '@relay/engine';
import { callOk, openFakeRuntime, sleep } from './demo-runtime.js';

interface Job {
  readonly userDataDir: string;
  readonly projectId: ProjectId;
  readonly workflowId: WorkflowId;
  readonly goal: string;
  readonly relPaths: readonly string[];
}

async function main(): Promise<void> {
  const job = JSON.parse(process.argv[2] ?? '{}') as Job;
  const hooks = crashHooksFromEnv(process.env);
  if (hooks === undefined) throw new Error('demo-crash-child needs RELAY_E2E=1 and RELAY_CRASH_AT');
  const rt = await openFakeRuntime(job.userDataDir, { hooks });
  await callOk(rt, 'relay/v1/runs.start', {
    idempotencyKey: 'demo-prepare-run-interrupt', projectId: job.projectId, workflowId: job.workflowId, workflowVersion: 1, goal: job.goal,
    input: { kind: 'files', relPaths: [...job.relPaths] },
  });
  await rt.engine.start();
  // The crash hook exits the process; reaching the deadline means it never fired.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) await sleep(20);
  await rt.dispose();
  throw new Error('crash hook did not fire');
}

main().catch((e: unknown) => {
  process.stderr.write(`${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
  process.exit(1);
});
