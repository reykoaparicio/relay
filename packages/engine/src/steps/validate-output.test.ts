import { describe, expect, it } from 'vitest';
import { FAKE_FIXTURES } from '@relay/providers';
import { createTemplateRegistry } from '@relay/templates';
import { SAMPLE_FILES } from '../testing/harness.js';
import type { ValidationInputs } from './validate-output.js';
import { NO_INPUTS, validateOutput } from './validate-output.js';

const templates = createTemplateRegistry();
const files = new Map<string, string | null>(Object.entries(SAMPLE_FILES));
const inputs = (over: Partial<ValidationInputs> = {}): ValidationInputs => ({ files, approvedScope: null, isRevision: false, ...over });
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- typed view of a fixture clone
const fixture = <T>(name: string): T => structuredClone(FAKE_FIXTURES[name]) as T;
const codes = (v: ReturnType<typeof validateOutput>) =>
  v.ok ? [] : ((v.error.details?.['issues'] ?? []) as { code: string; path: string }[]).map((i) => `${i.path}:${i.code}`);

interface Ref { relPath: string; startLine: number | null; endLine: number | null }
interface Findings { sourceRefs: Ref[]; findings: { sourceRefs: Ref[] }[] }
interface Plan { fileScope: string[]; steps: unknown[] }
interface Patch { files: { relPath: string; changeType: string; unifiedDiff: string }[] }

describe('validateOutput (F8): Zod first, then semantic checks against the input snapshot', () => {
  it('accepts every fake happy-path fixture against the sample-api snapshot', () => {
    const scope = fixture<Plan>('plan.v1').fileScope;

    expect(validateOutput({ outputSchema: 'findings.v1' }, fixture('findings.v1'), templates, inputs()).ok).toBe(true);
    expect(validateOutput({ outputSchema: 'plan.v1' }, fixture('plan.v1'), templates, inputs()).ok).toBe(true);
    expect(validateOutput({ outputSchema: 'patch.v1' }, fixture('patch.v1'), templates, inputs({ approvedScope: scope })).ok).toBe(true);
    expect(validateOutput({ outputSchema: 'review.v1' }, fixture('review.v1.accept'), templates, inputs()).ok).toBe(true);
  });

  it('rejects invalid JSON and Zod failures as OUTPUT_INVALID with issues', () => {
    const notJson = validateOutput({ outputSchema: 'findings.v1' }, undefined, templates);
    const bad = validateOutput({ outputSchema: 'findings.v1' }, { summary: '' }, templates, NO_INPUTS);

    expect(notJson.ok ? null : notJson.error.code).toBe('OUTPUT_INVALID');
    expect(codes(notJson)).toEqual([':invalid_json']);
    expect(bad.ok ? null : bad.error.code).toBe('OUTPUT_INVALID');
  });

  it('findings.v1: every sourceRef must be an input file with lines inside the file', () => {
    const f = fixture<Findings>('findings.v1');
    f.sourceRefs = [{ relPath: 'src/nope.ts', startLine: 1, endLine: 1 }, { relPath: 'src/lib/format.ts', startLine: 999, endLine: 1000 },
      { relPath: 'src/lib/format.ts', startLine: 5, endLine: 2 }];
    const first = f.findings[0];
    if (first !== undefined) first.sourceRefs = [{ relPath: 'README.md', startLine: null, endLine: null }];

    expect(codes(validateOutput({ outputSchema: 'findings.v1' }, f, templates, inputs()))).toEqual([
      'sourceRefs[0].relPath:unknown_file', 'sourceRefs[1].startLine:line_out_of_range', 'sourceRefs[1].endLine:line_out_of_range',
      'sourceRefs[2].endLine:line_range_inverted', 'findings[0].sourceRefs[0].relPath:unknown_file',
    ]);
  });

  it('findings.v1: a path-only input (diff run, null content) skips the line check', () => {
    const f = fixture<Findings>('findings.v1');
    const pathOnly = new Map<string, string | null>([...files].map(([k]) => [k, null]));

    expect(validateOutput({ outputSchema: 'findings.v1' }, { ...f, sourceRefs: [{ relPath: 'src/lib/format.ts', startLine: 9999, endLine: null }] }, templates,
      inputs({ files: pathOnly })).ok).toBe(true);
  });

  it('plan.v1: the file scope must be input files (P0 patches only touch provided files)', () => {
    const p = fixture<Plan>('plan.v1');
    p.fileScope = ['src/handlers/user.ts', 'src/server.ts'];

    expect(codes(validateOutput({ outputSchema: 'plan.v1' }, p, templates, inputs()))).toEqual(['fileScope[1]:scope_outside_inputs']);
  });

  it('patch.v1: each diff parses AND applies cleanly to the snapshot content', () => {
    const p = fixture<Patch>('patch.v1');
    const [user, orders, format] = p.files;
    if (user === undefined || orders === undefined || format === undefined) throw new Error('fixture');
    user.unifiedDiff = user.unifiedDiff.replace("const age = body['age'] as number;", 'const age = 42;'); // context no longer matches
    orders.unifiedDiff = 'not a diff at all';
    format.unifiedDiff = format.unifiedDiff.replaceAll('src/lib/format.ts', 'src/lib/other.ts');

    expect(codes(validateOutput({ outputSchema: 'patch.v1' }, p, templates, inputs()))).toEqual([
      'files[0].unifiedDiff:diff_does_not_apply', 'files[1].unifiedDiff:diff_unparseable', 'files[2].unifiedDiff:diff_file_mismatch',
    ]);
  });

  it('patch.v1: a diff with a malformed hunk header does not parse', () => {
    const p = fixture<Patch>('patch.v1');
    const first = p.files[0];
    if (first === undefined) throw new Error('fixture');
    p.files = [{ ...first, unifiedDiff: '--- a/src/handlers/user.ts\n+++ b/src/handlers/user.ts\n@@ -1,3 +1,3 @@\n-a\n' }];

    expect(codes(validateOutput({ outputSchema: 'patch.v1' }, p, templates, inputs()))[0]).toMatch(/diff_unparseable|diff_does_not_apply/);
  });

  it('patch.v1: files outside the approved scope are OUTPUT_INVALID first time, APPROVAL_STALE(scope_changed) in a revision', () => {
    const p = fixture<Patch>('patch.v1');
    const scope = ['src/handlers/user.ts', 'src/handlers/orders.ts'];

    const first = validateOutput({ outputSchema: 'patch.v1' }, p, templates, inputs({ approvedScope: scope }));
    const revision = validateOutput({ outputSchema: 'patch.v1' }, p, templates, inputs({ approvedScope: scope, isRevision: true }));

    expect(codes(first)).toEqual(['files:outside_approved_scope']);
    expect(revision.ok ? null : [revision.error.code, revision.error.details?.['reason'], revision.error.details?.['outsideScope']])
      .toEqual(['APPROVAL_STALE', 'scope_changed', ['src/lib/format.ts']]);
  });

  it('patch.v1: a file that is not an input is always OUTPUT_INVALID (even in a revision); path-only inputs skip the apply', () => {
    const p = fixture<Patch>('patch.v1');
    const first = p.files[0];
    if (first === undefined) throw new Error('fixture');
    const outside = { ...p, files: [{ ...first, relPath: 'src/server.ts' }] };
    const pathOnly = new Map<string, string | null>([['src/handlers/user.ts', null]]);

    expect(codes(validateOutput({ outputSchema: 'patch.v1' }, outside, templates, inputs({ isRevision: true })))).toEqual(['files[0].relPath:unknown_file']);
    expect(validateOutput({ outputSchema: 'patch.v1' }, { ...p, files: [first] }, templates, inputs({ files: pathOnly })).ok).toBe(true);
  });

  it('review.v1: revise requires at least one requested change (Zod refinement + the semantic check)', () => {
    const revise = fixture<{ requestedChanges: unknown[] }>('review.v1.revise');
    const permissive = { schema: () => ({ safeParse: (v: unknown) => ({ success: true as const, data: v }) }) } as unknown as typeof templates;

    expect(validateOutput({ outputSchema: 'review.v1' }, revise, templates, inputs()).ok).toBe(true);
    expect(validateOutput({ outputSchema: 'review.v1' }, { ...revise, requestedChanges: [] }, templates, inputs()).ok).toBe(false);
    expect(codes(validateOutput({ outputSchema: 'review.v1' }, { ...revise, requestedChanges: [] }, permissive, inputs()))).toEqual(['requestedChanges:revise_without_changes']);
  });

  it('plan.v1: more than 12 steps is rejected (semantic check behind a permissive schema)', () => {
    const p = fixture<Plan>('plan.v1');
    const permissive = { schema: () => ({ safeParse: (v: unknown) => ({ success: true as const, data: v }) }) } as unknown as typeof templates;

    expect(codes(validateOutput({ outputSchema: 'plan.v1' }, { ...p, steps: Array.from({ length: 13 }, () => p.steps[0]) }, permissive, inputs()))).toEqual(['steps:plan_steps_count']);
  });
});
