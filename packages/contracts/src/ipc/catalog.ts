import { z } from 'zod';
import type { IpcEnvelope } from '../result.js';
import type { RunAction } from '../status.js';
import { appOps } from './app.js';
import { approvalOps } from './approvals.js';
import { artifactOps } from './artifacts.js';
import type { AnyOperationDef } from './common.js';
import type { InternalChannel } from './internal.js';
import { INTERNAL_RUNNER_OPS } from './internal.js';
import { ledgerOps } from './ledger.js';
import { memoryOps } from './memory.js';
import { profileOps } from './profiles.js';
import { projectOps } from './projects.js';
import { providerOps } from './providers.js';
import { runOps } from './runs.js';
import { workflowOps } from './workflows.js';

/**
 * Renderer-exposed operations (02 §B5). The preload allowlist and `ipcMain` registrations are built from THIS object
 * only. `INTERNAL_RUNNER_OPS` is never merged in.
 */
export const OPERATIONS = {
  ...appOps,
  ...projectOps,
  ...providerOps,
  ...profileOps,
  ...workflowOps,
  ...runOps,
  ...approvalOps,
  ...memoryOps,
  ...artifactOps,
  ...ledgerOps,
} as const;

/** Key of {@link OPERATIONS} (`'runs.start'`, …). */
export type OperationKey = keyof typeof OPERATIONS;
/** Renderer-exposed channel. */
export type Channel = (typeof OPERATIONS)[OperationKey]['channel'];

/** Main+runner composites whose runner half is served under the SAME channel (the rest call INTERNAL_RUNNER_OPS). */
export const FORWARDED_COMPOSITE_CHANNELS = [
  'relay/v1/app.getDiagnostics',
  'relay/v1/providers.list',
  'relay/v1/providers.test',
] as const satisfies readonly Channel[];

/** Renderer channels served by the runner (route `runner`, plus forwarded composites). */
export type RunnerRoutedChannel =
  | Extract<(typeof OPERATIONS)[OperationKey], { route: 'runner' }>['channel']
  | (typeof FORWARDED_COMPOSITE_CHANNELS)[number];

type AllOps = typeof OPERATIONS & typeof INTERNAL_RUNNER_OPS;
type DefOf<C> = Extract<AllOps[keyof AllOps], { channel: C }>;
/** Input type (before parsing) of channel `C`. */
export type InputOf<C extends Channel | InternalChannel> = z.input<DefOf<C>['input']>;
/** Output type (after parsing) of channel `C`. */
export type OutputOf<C extends Channel | InternalChannel> = z.output<DefOf<C>['output']>;
/** Channel-typed boundary result. */
export type IpcResult<C extends Channel | InternalChannel> = IpcEnvelope<OutputOf<C>>;

/** Everything the runner's handler table must serve (06 F1 `Record<RunnerChannel, Handler>`). */
export type RunnerChannel = RunnerRoutedChannel | InternalChannel;
/** Runner handler input. */
export type RunnerInputOf<C extends RunnerChannel> = InputOf<C>;
/** Runner handler output. */
export type RunnerOutputOf<C extends RunnerChannel> = OutputOf<C>;

/** All renderer-exposed operation definitions. */
export const OPERATION_LIST: readonly AnyOperationDef[] = Object.values(OPERATIONS);
/** All internal runner operation definitions. */
export const INTERNAL_OPERATION_LIST: readonly AnyOperationDef[] = Object.values(INTERNAL_RUNNER_OPS);

/** Every channel the runner serves, in catalog order. */
export const RUNNER_CHANNELS: readonly RunnerChannel[] = [
  ...OPERATION_LIST.filter(
    (d) => d.route === 'runner' || (FORWARDED_COMPOSITE_CHANNELS as readonly string[]).includes(d.channel),
  ).map((d) => d.channel as RunnerChannel),
  ...INTERNAL_OPERATION_LIST.map((d) => d.channel as RunnerChannel),
];

/** Schema accepting exactly the {@link RunnerChannel}s (runner protocol, B7). */
export const runnerChannelSchema: z.ZodType<RunnerChannel> = z.enum(
  RUNNER_CHANNELS as unknown as readonly [RunnerChannel, ...RunnerChannel[]],
);

const CHANNEL_INDEX: ReadonlyMap<string, AnyOperationDef> = new Map(OPERATION_LIST.map((d) => [d.channel, d]));
const RUNNER_INDEX: ReadonlyMap<string, AnyOperationDef> = new Map(
  [...OPERATION_LIST, ...INTERNAL_OPERATION_LIST]
    .filter((d) => (RUNNER_CHANNELS as readonly string[]).includes(d.channel))
    .map((d) => [d.channel, d]),
);

/** Type guard: `value` is a renderer-exposed channel (preload allowlist check). */
export function isChannel(value: unknown): value is Channel {
  return typeof value === 'string' && CHANNEL_INDEX.has(value);
}

/** Looks up a renderer-exposed operation by channel. */
export function getOperation(channel: string): AnyOperationDef | undefined {
  return CHANNEL_INDEX.get(channel);
}

/** Looks up an operation the runner serves (renderer-routed or internal) by channel. */
export function getRunnerOperation(channel: string): AnyOperationDef | undefined {
  return RUNNER_INDEX.get(channel);
}

/** How the renderer performs a run action: one channel, a choice of channels, or navigation (10 J8). */
export type RunActionTarget = Channel | readonly [Channel, ...Channel[]] | 'navigate';

/**
 * 02 §B5 "Run actions → IPC ops". `choose_profile`: failed step → `runs.retryStep { profileId }`, otherwise
 * `runs.resume { switch_profile }`. `reconnect_provider` navigates to Settings → Providers.
 */
export const RUN_ACTION_OPS = {
  pause: 'relay/v1/runs.pause',
  cancel: 'relay/v1/runs.cancel',
  stop: 'relay/v1/runs.cancel',
  resume: 'relay/v1/runs.resume',
  approve: 'relay/v1/approvals.decide',
  request_revision: 'relay/v1/approvals.decide',
  reject: 'relay/v1/approvals.decide',
  increase_allowance: 'relay/v1/runs.increaseAllowance',
  edit_project_allowance: 'relay/v1/projects.update',
  choose_profile: ['relay/v1/runs.retryStep', 'relay/v1/runs.resume'],
  retry_step: 'relay/v1/runs.retryStep',
  raise_limits: 'relay/v1/runs.resume',
  acknowledge_overrun: 'relay/v1/runs.resume',
  reconnect_provider: 'navigate',
  resnapshot_and_replan: 'relay/v1/runs.resume',
  use_preserved_snapshot: 'relay/v1/runs.resume',
  decide_unknown: 'relay/v1/runs.decideUnknown',
  review_recovery: 'relay/v1/runs.resume',
  export_report: 'relay/v1/artifacts.export',
  export_patch: 'relay/v1/artifacts.export',
} as const satisfies Record<RunAction, RunActionTarget>;
