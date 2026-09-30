import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { formatIssuePath, toValidationIssues, validationIssueSchema } from './validation.js';

describe('validation helpers', () => {
  it('formats issue paths with dots and brackets', () => {
    expect(formatIssuePath(['steps', 1, 'dependsOn', 0])).toBe('steps[1].dependsOn[0]');
    expect(formatIssuePath(['limits', 'budgetMicrousd'])).toBe('limits.budgetMicrousd');
    expect(formatIssuePath([])).toBe('');
    expect(formatIssuePath([0, 'a'])).toBe('[0].a');
    expect(formatIssuePath([Symbol('s'), Symbol()])).toBe('s.symbol');
  });

  it('converts Zod issues to schema-valid ValidationIssues', () => {
    const r = z.object({ limits: z.object({ budgetMicrousd: z.number().max(5) }) }).safeParse({
      limits: { budgetMicrousd: 10 },
    });

    const issues = toValidationIssues(r.error?.issues ?? []);

    expect(issues).toEqual([
      { path: 'limits.budgetMicrousd', message: expect.any(String) as string, code: 'too_big' },
    ]);
    for (const i of issues) expect(validationIssueSchema.safeParse(i).success).toBe(true);
    expect(toValidationIssues([{ path: [], message: 'm'.repeat(500), code: 'c' }])[0]?.message).toHaveLength(
      400,
    );
  });

  it('splits unrecognized_keys into one field-specific issue per key (B10)', () => {
    const r = z.strictObject({ steps: z.array(z.strictObject({ id: z.string() })) }).safeParse({
      steps: [{ id: 'a', tempreature: 1, topP: 2 }],
    });

    const issues = toValidationIssues(r.error?.issues ?? []);

    expect(issues.map((i) => i.path)).toEqual(['steps[0].tempreature', 'steps[0].topP']);
    expect(issues.every((i) => i.code === 'unrecognized_keys')).toBe(true);
    expect(toValidationIssues([{ path: ['x'], message: 'm', code: 'unrecognized_keys', keys: [] }])).toEqual([
      { path: 'x', message: 'm', code: 'unrecognized_keys' },
    ]);
  });
});
