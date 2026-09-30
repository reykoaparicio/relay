import { useState } from 'react';
import type { ReactElement } from 'react';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { FolderGit2, Inbox, Play, Settings } from 'lucide-react';
import { PAUSE_REASONS, RUN_STATUSES } from '@relay/contracts';
import { axe, describeViolations, renderWithProviders } from './test-utils';
import {
  approval,
  appError,
  attempt,
  budgetBreakdown,
  capabilityWarning,
  catalogModel,
  costSummary,
  fakeSha,
  manifest,
  memoryRecord,
  plan,
  runDetail,
  step,
} from './test-fixtures';
import {
  AppShell,
  ApprovalCard,
  AttemptsTable,
  BudgetBreakdownTable,
  BudgetLedger,
  BudgetMeter,
  Button,
  ButtonLink,
  Card,
  CardHeader,
  CatalogTable,
  Checkbox,
  ConfirmDialog,
  ConflictCompare,
  ContextManifestView,
  CopyButton,
  DataTable,
  EmptyState,
  ErrorView,
  FakeProviderBadge,
  Field,
  FileTree,
  Hash,
  IconButton,
  InlineAlert,
  KeyValueList,
  MemoryRecordCard,
  Money,
  MoneyInput,
  NumberInput,
  PageHeader,
  ProjectSwitcher,
  RadioGroup,
  RecoveryPanel,
  RelativeTime,
  ResponsivePanels,
  Select,
  SideNav,
  Skeleton,
  StatTile,
  Stepper,
  StatusBadge,
  StepTimeline,
  Tabs,
  TextInput,
  Textarea,
} from './index';

const noop = vi.fn();

function Controlled({ children }: { readonly children: (v: string, set: (v: string) => void) => ReactElement }) {
  const [value, setValue] = useState('');
  return children(value, setValue);
}

function setWidth(px: number) {
  act(() => {
    window.innerWidth = px;
    window.dispatchEvent(new Event('resize'));
  });
}

const panels = (
  <ResponsivePanels
    label="Step details"
    value="output"
    onValueChange={noop}
    tabs={[
      { id: 'output', label: 'Output', content: <p>Output body</p> },
      { id: 'attempts', label: 'Attempts', content: <p>Attempts body</p> },
    ]}
    secondary={[
      { id: 'ledger', label: 'Budget ledger', content: <p>Ledger body</p> },
      { id: 'context', label: 'Context used', content: <p>Context body</p> },
    ]}
  />
);

// DiffViewer's axe check lives in domain/DiffViewer.test.tsx (it is not exported from the barrel; lazy only).
/** Each scenario renders one component in a main state; all live inside `<main>` like the app does. */
const SCENARIOS: ReadonlyArray<readonly [string, () => ReactElement, { readonly bare?: boolean }?]> = [
  ['Button variants + pending', () => (
    <div className="actions">
      <Button variant="primary" icon={Play}>Start run</Button>
      <Button>Secondary</Button>
      <Button variant="danger">Stop</Button>
      <Button variant="ghost">Ghost</Button>
      <Button pending>Saving</Button>
      <IconButton label="Open settings" icon={Settings} />
      <ButtonLink href="#/runs" variant="primary" icon={Play}>Review recovery options</ButtonLink>
      <ButtonLink href="#/memory" size="sm">Manage memory</ButtonLink>
    </div>
  )],
  ['StatusBadge: every run status and pause reason', () => (
    <div>
      {RUN_STATUSES.map((s) => <StatusBadge key={s} kind="run" value={s} />)}
      {PAUSE_REASONS.map((r) => <StatusBadge key={r} kind="run" value="paused" pauseReason={r} showDetail />)}
    </div>
  )],
  ['Card + StatTile + KeyValueList', () => (
    <>
      <Card labelledBy="c1"><CardHeader title="Budget" titleId="c1" actions={<Button>Edit</Button>} /><p>Body</p></Card>
      <StatTile label="Tracked this month" value={<Money value={costSummary().allowance} />} hint="of $50.00" href="#/runs" />
      <StatTile label="Runs" value="12" />
      <StatTile
        label="Usage tracked by Relay"
        labelAside="September"
        value={<Money value={costSummary().allowance} />}
        href="#/usage"
        secondaryAction={<a href="#/ledger">Open usage ledger</a>}
      />
      <KeyValueList items={[{ term: 'Model', value: 'claude-opus-5-5', mono: true }, { term: 'Profile', value: 'Balanced' }]} />
    </>
  )],
  ['PageHeader with live status', () => (
    <PageHeader
      title="Run 024"
      breadcrumbs={[{ label: 'Runs', href: '#/runs' }, { label: 'Run 024' }]}
      status={<StatusBadge kind="run" value="awaiting_approval" />}
      actions={<Button variant="danger">Stop</Button>}
    />
  )],
  ['Form controls', () => (
    <form>
      <Field label="Goal" hint="One sentence" error="Enter a goal" required>
        {(c) => <TextInput {...c} value="" onValueChange={noop} />}
      </Field>
      <Field label="Notes">{(c) => <Textarea {...c} value="" onValueChange={noop} />}</Field>
      <Field label="Profile">
        {(c) => <Select {...c} value="a" onValueChange={noop} options={[{ value: 'a', label: 'Balanced' }, { value: 'b', label: 'Economy' }]} />}
      </Field>
      <Field label="Max attempts">{(c) => <NumberInput {...c} value="10" onValueChange={noop} min={1} max={50} />}</Field>
      <Controlled>{(v, set) => <MoneyInput label="Run allowance" value={v} onValueChange={set} hint="USD" />}</Controlled>
      <MoneyInput label="Project allowance" value="abc" onValueChange={noop} />
      <Checkbox label="Include pinned rules" checked onCheckedChange={noop} />
      <RadioGroup legend="Scope" value="run" onValueChange={noop}
        options={[{ value: 'run', label: 'This run', description: 'Only now' }, { value: 'project', label: 'Project' }]} />
    </form>
  )],
  ['Stepper', () => (
    <Stepper label="Setup progress" currentKey="provider"
      steps={[{ key: 'project', label: 'Select project' }, { key: 'provider', label: 'Connect provider' }, { key: 'run', label: 'First run' }]} />
  )],
  ['Tabs', () => (
    <Tabs label="Details" value="a" onValueChange={noop}
      tabs={[{ id: 'a', label: 'Output', content: <p>A</p> }, { id: 'b', label: 'Context', content: <p>B</p> }]} />
  )],
  ['InlineAlert tones + ErrorView', () => (
    <>
      <InlineAlert tone="warning" title="Paused">Budget</InlineAlert>
      <InlineAlert tone="info" title="Info" actions={<Button>Do</Button>} />
      <InlineAlert tone="unknown" title="Unknown outcome" />
      <InlineAlert tone="success" title="Done" />
      <ErrorView error={appError({ correlationId: 'cor_00000000000000000000000001' })} onAction={noop} />
    </>
  )],
  ['DataTable activatable + empty', () => (
    <>
      <DataTable caption="Runs" columns={[{ key: 'n', header: 'Run', cell: (r: { id: string }) => r.id }, { key: 'c', header: 'Cost', numeric: true, cell: () => '$0.48' }]}
        rows={[{ id: 'Run 1' }, { id: 'Run 2' }]} getRowKey={(r) => r.id} onRowActivate={noop} />
      <DataTable caption="Empty" columns={[]} rows={[]} getRowKey={() => ''} emptyState={<EmptyState title="No runs yet" body="Start one" icon={Inbox} />} />
    </>
  )],
  ['Hash, CopyButton, Money, RelativeTime, Skeleton', () => (
    <div aria-busy="true">
      <Hash value={fakeSha('6f4a')} label="plan hash" />
      <CopyButton value="x" label="Copy run id" />
      <Money value={costSummary().settledEstimated} certainty="estimated" />
      <RelativeTime epochMs={0} now={180_000} showAbsolute />
      <Skeleton lines={3} />
    </div>
  )],
  ['AppShell + SideNav + ProjectSwitcher + FakeProviderBadge', () => (
    <AppShell
      nav={<SideNav activeKey="runs" items={[
        { key: 'overview', label: 'Overview', href: '#/', icon: FolderGit2 },
        { key: 'runs', label: 'Runs', href: '#/runs', icon: Play, badgeCount: 3, badgeLabel: (n) => `${String(n)} waiting for approval` },
      ]} />}
      workspace={<>
        <ProjectSwitcher projects={[{ id: 'p1', name: 'sample-api', detail: '~/code/sample-api' }]} activeId="p1" onSelect={noop} />
        <FakeProviderBadge />
      </>}
    >
      <h1>Overview</h1>
    </AppShell>
  ), { bare: true }],
  ['StepTimeline', () => (
    <StepTimeline selectedId={step(2).id} onSelect={noop}
      steps={[step(1), step(2, { stepKey: 'plan', state: 'awaiting_approval' }), step(3, { stepKey: 'patch', state: 'pending', profileName: null })]} />
  )],
  ['BudgetMeter + BudgetLedger + BudgetBreakdownTable', () => (
    <>
      <BudgetMeter cost={costSummary()} />
      <BudgetLedger cost={costSummary()} byStep={[{ stepKey: 'review', cost: costSummary() }]} />
      <BudgetBreakdownTable breakdown={budgetBreakdown()} />
    </>
  )],
  ['ApprovalCard', () => <ApprovalCard approval={approval()} plan={plan()} onDecide={noop} />],
  ['AttemptsTable', () => <AttemptsTable attempts={[attempt(1), attempt(2, { state: 'unknown', cost: { microusd: 900_000, certainty: 'unknown' } })]} />],
  ['ContextManifestView', () => <ContextManifestView manifest={manifest()} />],
  ['FileTree', () => (
    <FileTree included={[{ relPath: 'src/index.ts', sizeBytes: 1200 }]} excluded={[{ relPath: '.env', reason: 'secret' }, { relPath: 'node_modules', reason: 'dependency_dir' }]} />
  )],
  ['MemoryRecordCard + ConflictCompare', () => (
    <>
      <ul className="list">
        <li><MemoryRecordCard record={memoryRecord(1, { stale: true, pinned: true })} selected onSelect={noop} /></li>
        <li><MemoryRecordCard record={memoryRecord(2, { status: 'suggested' })} selected={false} onSelect={noop} /></li>
      </ul>
      <ConflictCompare a={memoryRecord(1)} b={memoryRecord(2, { status: 'suggested' })} onResolve={noop} />
    </>
  )],
  ['RecoveryPanel', () => <RecoveryPanel run={runDetail()} onDecide={noop} />],
  ['CatalogTable', () => (
    <CatalogTable entries={[catalogModel()]} catalogVersion="2026-09-30" profileChecks={{ 'claude-opus-5-5': [capabilityWarning()] }} />
  )],
];

const CASES = SCENARIOS.map(([name, build, opts]) => ({ name, build, bare: opts?.bare === true }));

afterEach(() => { setWidth(1024); });

/*
 * Structure only: axe checks roles, names, labels, landmarks, and ARIA here. jsdom computes no colors,
 * so `color-contrast` is disabled (test-utils `axe`) and the markup is identical in both themes; running
 * these again with data-theme="light" would test nothing new. The dark AND light contrast guarantee
 * comes from styles/contrast.test.ts, which resolves every rendered text/background pair per palette.
 */
describe('axe structure (theme-independent; contrast lives in styles/contrast.test.ts) @a11y', () => {
  it.each(CASES)('$name has no violations', async ({ build, bare }) => {
    const ui = bare ? build() : <main>{build()}</main>;
    const { baseElement } = renderWithProviders(ui);

    expect(describeViolations(await axe(baseElement))).toEqual([]);
  });

  it.each([1100, 1440])('ResponsivePanels at %ipx has no violations', async (width) => {
    setWidth(width);
    const { baseElement } = renderWithProviders(<main>{panels}</main>);

    expect(describeViolations(await axe(baseElement))).toEqual([]);
  });

  it('open ConfirmDialog has no violations', async () => {
    const { baseElement } = renderWithProviders(
      <ConfirmDialog open onOpenChange={noop} title="Stop this run?" consequences="Finished steps are kept." confirmLabel="Stop run" onConfirm={noop} />,
    );
    await screen.findByRole('dialog');

    expect(describeViolations(await axe(baseElement))).toEqual([]);
  });
});

describe('theme switching', () => {
  it.each(['dark', 'light'] as const)('ThemeProvider stamps data-theme="%s" on the root element', (theme) => {
    renderWithProviders(<main><p>Body</p></main>, { theme });

    expect(document.documentElement.dataset['theme']).toBe(theme);
  });
});
