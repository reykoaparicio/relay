// 13 §M4: the evaluation tasks, the evaluation-only single-step variant, and the evaluate.ts spending guards.
// No test here may ever reach live mode: every child gets an explicit env without RELAY_LIVE_TESTS unless a case
// checks a refusal, and no case passes RELAY_LIVE_TESTS=1 together with --cap-usd.
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { workflowSpecSchema } from '@relay/contracts';
import { REPO_ROOT, runScript } from './run-script.js';

const TASKS = join(REPO_ROOT, 'tests', 'evaluations', 'tasks');

describe('evaluation tasks', () => {
  it('has 6–10 task files whose goals never contain their answer terms and that share the same approved rules (§17.3)', async () => {
    const files = (await readdir(TASKS)).filter((f) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThanOrEqual(6);
    expect(files.length).toBeLessThanOrEqual(10);
    const rules = new Set<string>();
    for (const f of files) {
      const t = JSON.parse(await readFile(join(TASKS, f), 'utf8')) as { id: string; goal: string; answerLeakTerms: string[]; approvedRules: unknown; acceptance: string[] };
      expect(f).toBe(`${t.id}.json`);
      expect(t.acceptance.length).toBeGreaterThan(0);
      for (const term of t.answerLeakTerms) expect(t.goal.toLowerCase(), `${t.id} goal leaks "${term}"`).not.toMatch(new RegExp(`(^|[^a-z0-9])${term.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`));
      rules.add(JSON.stringify(t.approvedRules));
    }
    expect(rules.size).toBe(1);
  });

  it('the single-step variant is a valid workflow spec with one implementer pass and no revision loop', async () => {
    const raw = JSON.parse(await readFile(join(REPO_ROOT, 'tests', 'evaluations', 'templates', 'single-step.workflow.json'), 'utf8')) as unknown;
    const spec = workflowSpecSchema.parse(raw);
    expect(spec.id).toBe('eval-single-step');
    expect(spec.limits.maxRevisionCycles).toBe(0);
    expect(spec.steps.filter((s) => s.kind === 'model' && s.role === 'implementer')).toHaveLength(1);
  });
});

describe('evaluate.ts guards', () => {
  it('--dry-run validates the tasks and prints planned runs with an upper bound, sending nothing', async () => {
    const r = await runScript('evaluate.ts', ['--dry-run', '--tasks', 'T1,T2', '--config', 'both']);

    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('Validated 9 task file(s)');
    expect(r.stdout).toMatch(/Planned runs \(4\)/);
    expect(r.stdout).toMatch(/Estimated upper bound: \$\d+\.\d\d for 4 run\(s\)/);
    expect(r.stdout).toContain('Dry run complete: 0 requests sent, $0.00 spent.');
  });

  it('refuses live mode without RELAY_LIVE_TESTS=1', async () => {
    const r = await runScript('evaluate.ts', ['--tasks', 'T1', '--cap-usd', '1']);

    expect(r.code).toBe(2);
    expect(r.stderr).toContain('needs BOTH RELAY_LIVE_TESTS=1 and --cap-usd');
  });

  it('refuses live mode without --cap-usd even when RELAY_LIVE_TESTS=1', async () => {
    const r = await runScript('evaluate.ts', ['--tasks', 'T1'], { RELAY_LIVE_TESTS: '1' });

    expect(r.code).toBe(2);
    expect(r.stderr).toContain('needs BOTH RELAY_LIVE_TESTS=1 and --cap-usd');
  });

  it('rejects an unknown task id', async () => {
    const r = await runScript('evaluate.ts', ['--dry-run', '--tasks', 'T99']);

    expect(r.code).toBe(2);
    expect(r.stderr).toContain('unknown task(s): T99');
  });
});
