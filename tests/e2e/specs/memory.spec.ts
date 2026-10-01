import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures.js';
import { invokeAsAnotherSession, projectIdOf, setupOwnProject, startRunViaNewRun } from '../flows.js';
import { NewRun, Runs } from '../pages/app-pages.js';
import { Memory } from '../pages/memory.js';
import { RunInspector } from '../pages/run-inspector.js';
import { Shell } from '../pages/shell.js';

// 12 §L4 memory.spec (FR-06) against the real Memory page and runner memory.* channels.
const GOAL = 'Validate the user id parameter in the user handler.';
/** The memory proposal of the fake verify output (providers fake-fixtures/review.v1.accept.json). */
const SUGGESTED_TITLE = 'Validate request fields with validate.ts helpers';

const RULE = { title: 'Response format', content: 'Preserve the existing public response format.' };

interface MemoryListItem {
  readonly id: string;
  readonly title: string;
  readonly currentRevision: number;
}

async function approvedRecord(page: Page, title: string): Promise<MemoryListItem> {
  const list = await invokeAsAnotherSession<MemoryListItem[]>(page, 'relay/v1/memory.list', {
    projectId: projectIdOf(page),
    status: ['approved'],
  });
  const rec = list.find((r) => r.title === title);
  if (rec === undefined) throw new Error(`no approved record "${title}"`);
  return rec;
}

test.describe('memory', { tag: '@m3' }, () => {
  test('add rule (dialog resets) → stale edit shows the conflict table → keep my changes → archive / restore', async ({
    page,
    stubDialogs,
    project,
  }) => {
    await setupOwnProject(page, stubDialogs, project);
    const shell = new Shell(page);
    await shell.nav('Memory');
    const memory = new Memory(page);
    await memory.expectLoaded();

    // Add rule: approved immediately, selected in the Approved tab.
    await memory.addRule(RULE);
    await expect(memory.toast('Rule added')).toBeVisible();
    await expect(memory.tab('Approved')).toHaveAccessibleName(/\(1\)/);
    await expect(memory.detail(RULE.title)).toContainText(RULE.content);

    // After a success the dialog starts over: every field is empty again.
    const reopened = await memory.openAddRule();
    const f = memory.ruleFields(reopened);
    await expect(f.title).toHaveValue('');
    await expect(f.content).toHaveValue('');
    await expect(f.pinned).not.toBeChecked();
    await reopened.getByRole('button', { name: 'Cancel' }).click();
    await expect(reopened).toBeHidden();

    // Edit, while another session saves revision 2 of the same record → CONFLICT → comparison table.
    const form = await memory.startEdit(RULE.title);
    await form.getByRole('textbox', { name: 'Content' }).fill('Mine: keep the response format and its field order.');
    const rec = await approvedRecord(page, RULE.title);
    expect(rec.currentRevision).toBe(1);
    await invokeAsAnotherSession(page, 'relay/v1/memory.update', {
      recordId: rec.id,
      expectedRevision: 1,
      title: 'Response format (theirs)',
    });
    await form.getByRole('button', { name: 'Save revision 2' }).click();
    const table = memory.conflictTable(form);
    await expect(table).toBeVisible();
    await expect(form).toContainText('This record changed since you opened it (now revision 2)');
    await expect(table.getByRole('row', { name: /^Title/ })).toContainText('Another session');
    await expect(table.getByRole('row', { name: /^Content/ })).toContainText('You');
    await expect(form.getByRole('button', { name: 'Save revision 2' })).toBeDisabled();

    // "Keep my changes" saves only my field over revision 2: their title stays, my content wins.
    await memory.keepMyChanges(form).click();
    await expect(memory.toast('Saved revision 3')).toBeVisible();
    await expect(form).toBeHidden();
    const theirs = 'Response format (theirs)';
    await expect(memory.detail(theirs)).toContainText('Mine: keep the response format and its field order.');
    expect((await approvedRecord(page, theirs)).currentRevision).toBe(3);

    // Archive → Archived tab → Restore to approved.
    await memory.archive(theirs);
    await expect(memory.records('Approved').getByRole('button')).toHaveCount(0);
    await expect(memory.tab('Archived')).toHaveAccessibleName(/\(1\)/);
    await memory.restore(theirs);
    await expect(memory.tab('Approved')).toHaveAccessibleName(/\(1\)/);
    await expect(memory.tab('Archived')).toHaveAccessibleName(/\(0\)/);
    await memory.openTab('Approved');
    await expect(memory.record('Approved', theirs)).toBeVisible();
  });

  test('approving a suggestion that conflicts with an approved record shows "Conflicts with" and "Combine with"', async ({
    page,
    stubDialogs,
    project,
  }) => {
    await setupOwnProject(page, stubDialogs, project);
    await startRunViaNewRun(page, GOAL);
    const inspector = new RunInspector(page);
    await inspector.expectAwaitingApproval();
    await inspector.approve();
    await inspector.waitForStatus('Completed');

    const shell = new Shell(page);
    await shell.nav('Memory');
    const memory = new Memory(page);
    await memory.expectLoaded();
    await expect(memory.tab('Suggested')).toHaveAccessibleName(/\(1\)/);

    // An approved rule with the same title in an overlapping scope.
    await memory.addRule({ title: SUGGESTED_TITLE, content: 'Cast request bodies after a manual check.' });
    await memory.openTab('Suggested');
    const card = memory.suggestion(SUGGESTED_TITLE);
    await expect(card).toContainText('Suggested, not used by runs');
    // (The completed run also recorded an approved run summary, so count relative to now.)
    const approvedBefore = await memory.tab('Approved').textContent();
    await memory.approveSuggestion(SUGGESTED_TITLE);
    await expect(card.getByText(`Conflicts with “${SUGGESTED_TITLE}”`)).toBeVisible();
    await expect(card).toContainText('Relay never keeps two conflicting approved records. Nothing was saved');
    const combine = card.getByRole('button', { name: `Combine with “${SUGGESTED_TITLE}”` });
    await expect(combine).toBeVisible();
    // Nothing was approved: the same approved records and still one suggestion.
    await expect(memory.tab('Approved')).toHaveText(approvedBefore ?? '');
    await expect(memory.tab('Suggested')).toHaveAccessibleName(/\(1\)/);

    // Combine opens the side-by-side resolver (nothing merged automatically).
    await combine.click();
    await expect(memory.tab('Approved')).toBeHidden();
    await expect(page.getByRole('main')).toContainText('Cast request bodies after a manual check.');
    await expect(page.getByRole('main')).toContainText('Handlers validate every body field with the helpers');
  });

  test('New run: an untouched picker uses every approved record; unticking all sends pinned-only', async ({
    page,
    stubDialogs,
    project,
  }) => {
    await setupOwnProject(page, stubDialogs, project);
    const shell = new Shell(page);
    await shell.nav('Memory');
    const memory = new Memory(page);
    await memory.expectLoaded();
    const pinned = { title: 'Pinned rule', content: 'Never change the public route names.', pinned: true };
    const a = { title: 'Rule A', content: 'Prefer early returns in handlers.' };
    const b = { title: 'Rule B', content: 'Keep error codes in SCREAMING_SNAKE_CASE.' };
    for (const r of [pinned, a, b]) await memory.addRule(r);

    await shell.nav('Runs');
    await new Runs(page).startWorkflow();
    const form = new NewRun(page);
    await form.expectLoaded();
    await form.fillGoal(GOAL);
    await form.expectReady();

    // Untouched: every approved record is ticked and the preflight lists all three.
    for (const r of [pinned, a, b]) await expect(form.memoryCheckbox(r.title)).toBeChecked();
    await expect(form.memoryCheckbox(pinned.title)).toBeDisabled();
    await expect(form.preflightMemory().getByRole('listitem')).toHaveCount(3);
    for (const r of [pinned, a, b]) await expect(form.preflightMemory()).toContainText(r.title);

    // Untick every non-pinned record: only the pinned rule remains (it is locked on).
    await form.memoryCheckbox(a.title).uncheck();
    await form.memoryCheckbox(b.title).uncheck();
    await expect(form.memoryCheckbox(pinned.title)).toBeChecked();
    await expect(form.preflightMemory().getByRole('listitem')).toHaveCount(1);
    await expect(form.preflightMemory().getByRole('listitem')).toContainText(pinned.title);
    await expect(form.preflightMemory().getByRole('listitem')).toContainText('pinned');
    await form.expectReady();
    await form.submit();
    await expect(page).toHaveURL(/#\/p\/[^/]+\/runs\/run_[^/?]+$/);

    // The started run's snapshot holds the pinned rule only.
    const inspector = new RunInspector(page);
    await inspector.expectAwaitingApproval();
    await inspector.selectStep('Review input');
    await expect(await inspector.contextSummaryValue('Approved memory records')).toHaveText('1');
  });
});
