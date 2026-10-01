import { describe, expect, it } from 'vitest';
import { parseTask, validateTask } from './eval-tasks.js';

const VALID = {
  id: 'T1-sample',
  title: 'Sample',
  category: 'input-validation',
  seededDefect: 'missing check',
  goal: 'Review the request handlers for problems.',
  input: { kind: 'files', relPaths: ['src/a.ts'] },
  approvedRules: [{ title: 'Rule', content: 'Keep it small.' }],
  acceptance: ['finds the defect'],
  answerLeakTerms: ['zod'],
};

describe('eval task files (evalTaskSchema + file rules)', () => {
  it('accepts a valid task and returns the parsed task', async () => {
    const r = await parseTask(VALID, 'T1-sample.json');

    expect(r.problems).toEqual([]);
    expect(r.task?.id).toBe('T1-sample');
  });

  it('reports schema problems with the field path', async () => {
    const problems = await validateTask({ ...VALID, category: 'nope', input: { kind: 'diff' }, acceptance: [] }, 'T1-sample.json');

    expect(problems.some((p) => p.startsWith('T1-sample.json: category'))).toBe(true);
    expect(problems.some((p) => p.startsWith('T1-sample.json: input.kind'))).toBe(true);
    expect(problems.some((p) => p.startsWith('T1-sample.json: acceptance'))).toBe(true);
    expect(await validateTask('x', 'T1-sample.json')).toEqual(['T1-sample.json: (root) Invalid input: expected object, received string']);
  });

  it('applies the file rules: file name, answer terms in the goal, and relPaths', async () => {
    const problems = await validateTask(
      { ...VALID, goal: 'Add zod validation to the handlers.', input: { kind: 'files', relPaths: ['../x.ts', '.env', 'a/./b.ts', '.env'] } },
      'other.json',
    );

    expect(problems).toEqual([
      'other.json: file name must be T1-sample.json',
      'other.json: goal embeds the answer term "zod" (§17.3)',
      'other.json: duplicate relPaths',
      'other.json: bad relPath ../x.ts',
      'other.json: relPath .env is excluded (secret, dependency, or build output)',
      'other.json: bad relPath a/./b.ts',
      'other.json: relPath .env is excluded (secret, dependency, or build output)',
    ]);
  });
});
