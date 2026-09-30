// 06 F1: engine ports. Storage, providers, tools, and templates are TYPE-ONLY here; implementations are injected
// (lint gate). G's context/memory modules implement ContextAssemblerPort / MemoryServicePort (07 G1/G5).
import type {
  APPROVAL_BIND_TARGETS,
  AttemptId,
  AttemptPurpose,
  Clock,
  ContextManifest,
  EpochMs,
  IdGen,
  IpcResult,
  MemoryId,
  MemoryScope,
  ModelOutputSchemaId,
  ProfileSnapshot,
  ProjectId,
  PushEvent,
  Result,
  RetryPolicy,
  Role,
  RunId,
  RunnerChannel,
  RunnerInputOf,
  Sha256,
  StepKey,
  ProviderId,
} from '@relay/contracts';
import type { AttemptRow, Db, RunRow, StepRow } from '@relay/storage';
import type { ProviderRegistry } from '@relay/providers';
import type { ArtifactStore, LiveHash, ProjectRoot, ReadOptions, ScanOptions, ScanResult, SelectedFile } from '@relay/tools';
import type { TemplateRegistry } from '@relay/templates';

/** Structured JSONL logger (00b §3). The providers `Logger` is a structural subset. */
export interface Logger {
  debug(event: string, fields?: Readonly<Record<string, unknown>>): void;
  info(event: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(event: string, fields?: Readonly<Record<string, unknown>>): void;
  error(event: string, fields?: Readonly<Record<string, unknown>>): void;
}

/** The ONLY timer source of the engine (R4-36): tests inject manual timers, never global fake timers. */
export interface Timers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

/** One credential request (02 R2-25): one `dispatch` resolve per attempt, before the estimate (attemptId null). */
export interface CredentialRequest {
  readonly providerId: ProviderId;
  readonly purpose: 'dispatch' | 'connection_test';
  readonly attemptId: AttemptId | null;
}

/** Resolves an API key through main (runner protocol). The key lives in memory only. */
export interface CredentialResolver {
  resolve(req: CredentialRequest): Promise<Result<string>>;
}

/** Context passed to every crash hook (F13). */
export interface CrashHookCtx {
  readonly attemptId?: AttemptId;
  readonly stepKey: StepKey;
  readonly purpose: AttemptPurpose | null;
  readonly attemptSeq: number;
}

/** Crash injection points (F13). Every hook is optional and absent in production. */
export interface EngineTestHooks {
  beforeReservationTx?(c: CrashHookCtx): void;
  afterDispatchIntent?(c: CrashHookCtx): void;
  afterProviderResponse?(c: CrashHookCtx): void;
  afterStepCommit?(c: CrashHookCtx): void;
  afterApprovalCommit?(c: CrashHookCtx): void;
}

/** Output artifact kind of a model step (the kind of its canonical output). */
export type OutputArtifactKind = 'findings' | 'plan' | 'patch' | 'review';

/** FR-03 snapshot of one model step (the plan's `ModelStepSpec`, 06 F15 `StepSnapshot`). */
export interface ModelStepSnapshot {
  readonly kind: 'model';
  readonly role: Role;
  readonly profile: ProfileSnapshot;
  readonly outputSchema: ModelOutputSchemaId;
  readonly outputKind: OutputArtifactKind;
  readonly instructionVersion: string;
  readonly maxOutputTokens: number;
  readonly retryPolicy: RetryPolicy;
  readonly memoryScope: MemoryScope;
  readonly dependsOn: readonly StepKey[];
}

/** Snapshot of an approval step (§11.3). */
export interface ApprovalStepSnapshot {
  readonly kind: 'approval';
  readonly bindTo: readonly (typeof APPROVAL_BIND_TARGETS)[number][];
  readonly dependsOn: readonly StepKey[];
}

/** Snapshot of a synthetic engine step (F15). */
export interface LocalStepSnapshot {
  readonly kind: 'intake' | 'finalize';
  readonly dependsOn: readonly StepKey[];
}

/** One step of the run snapshot. */
export type StepSnapshot = ModelStepSnapshot | ApprovalStepSnapshot | LocalStepSnapshot;

/** `runs.snapshot_json` (F15): revision 0 of the run configuration; never mutated. */
export interface RunSnapshot {
  readonly steps: Readonly<Record<string, StepSnapshot>>;
  readonly workflowContentHash: Sha256;
  readonly catalogVersion: string;
  readonly memoryIncludeIds: readonly MemoryId[];
}

/** 07 G1 input. */
export interface AssembleInput {
  readonly run: RunRow;
  readonly step: StepRow;
  readonly snapshot: ProfileSnapshot;
  readonly stepSpec: ModelStepSnapshot;
  readonly preservedSnapshot: boolean;
  readonly purpose: AttemptPurpose;
  readonly priorAttempts: readonly AttemptRow[];
}

/** 07 G1 output. */
export interface AssembledContext {
  readonly system: string;
  readonly user: string;
  readonly manifest: ContextManifest;
  readonly estimatedInputTokens: number;
}

/** Implemented by G (context.ts). */
export interface ContextAssemblerPort {
  assemble(input: AssembleInput): Promise<Result<AssembledContext>>;
}

/** Implemented by G (memory.ts). The memory.* IPC handlers are part of G5 (Wave 3). */
export interface MemoryServicePort {
  snapshotForRun(runId: RunId, projectId: ProjectId, o: { readonly includeIds?: readonly MemoryId[] }): Result<void>;
  proposeFromRun(runId: RunId): Result<void>;
  recordRunSummary(runId: RunId): Result<void>;
}

/** Wraps @relay/tools file access (05): confinement, exclusions, and caps live there. */
export interface ProjectFsPort {
  openRoot(rootRealpath: string): Promise<Result<ProjectRoot>>;
  readSelected(root: ProjectRoot, relPaths: readonly string[], opts?: ReadOptions): Promise<Result<{ files: SelectedFile[] }>>;
  hashFiles(root: ProjectRoot, relPaths: readonly string[]): Promise<Result<LiveHash[]>>;
  scan(root: ProjectRoot, opts?: ScanOptions): Promise<Result<ScanResult>>;
}

/** Storage C8 retention sweep, injected by runtime.ts. */
export interface MaintenancePort {
  sweepRawResponses(now: EpochMs, retentionDays: number): Promise<unknown>;
}

/** Everything the engine needs (00b §2.4: dependency injection via factory params). */
export interface EngineDeps {
  readonly db: Db;
  readonly providers: ProviderRegistry;
  readonly projectFs: ProjectFsPort;
  readonly artifacts: ArtifactStore;
  readonly context: ContextAssemblerPort;
  readonly memory: MemoryServicePort;
  readonly templates: TemplateRegistry;
  readonly credentials: CredentialResolver;
  readonly maintenance: MaintenancePort;
  readonly clock: Clock;
  readonly ids: IdGen;
  readonly logger: Logger;
  readonly emit: (e: PushEvent) => void;
  readonly timers: Timers;
  readonly hooks?: EngineTestHooks | undefined;
  /** Diagnostics extras only the composition root knows (e.g. the DB file size). */
  readonly diagnostics?: { dbSizeBytes(): number } | undefined;
  /** Idle wait of the loop when there is no work (default 1 s; commands wake it earlier). */
  readonly idleMs?: number | undefined;
}

/** One handler per runner-routed IPC op + INTERNAL_RUNNER_OPS (02 R2-1). */
export interface EngineApi {
  handle<C extends RunnerChannel>(channel: C, input: RunnerInputOf<C>): Promise<IpcResult<C>>;
  /** lease → recovery → missing reports → retention sweep → loop. */
  start(): Promise<void>;
  stop(opts: { graceMs: number }): Promise<void>;
}

// ---------------------------------------------------------------- engine-internal services

/** Why an in-flight attempt was aborted. */
export type AbortReason = { readonly kind: 'cancel' } | { readonly kind: 'deadline' };

/** F11: runId → in-flight AbortControllers. */
export interface CancellationRegistry {
  register(runId: RunId, attemptId: AttemptId): AbortController;
  unregister(controller: AbortController): void;
  abortRun(runId: RunId, reason: AbortReason): number;
  hasInFlight(runId: RunId): boolean;
}

/** F12: per-running-segment deadline timers. */
export interface DeadlineWatcher {
  arm(runId: RunId): void;
  disarm(runId: RunId): void;
  disarmAll(): void;
}

/** In-process wake-up signal for the loop (commands wake it; waits use the injected timers). */
export interface WakeSignal {
  signal(): void;
  wait(ms: number): Promise<void>;
}

/** EngineDeps plus the engine-internal services. */
export interface EngineCtx extends EngineDeps {
  readonly cancellation: CancellationRegistry;
  readonly deadlines: DeadlineWatcher;
  readonly wake: WakeSignal;
  /**
   * Runner-lease ownership (B3). `owned` turns false when `stop()` releases the lease (or a heartbeat finds it taken);
   * from then on no attempt is dispatched or settled by this process — the next owner's recovery handles them.
   * True for a context that never started (direct `tick` in tests).
   */
  readonly lease: { owned: boolean };
  /** Post-commit effect of every terminal transition (F17 report). */
  onTerminal(runId: RunId): Promise<void>;
}
