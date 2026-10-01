// 07 G1: context assembly (§10.2 steps 1–8, in order). 1 versioned instructions from the run's workflow-version prompt
// snapshot; 2 goal + immutable constraints; 3 approved memory from the run's intake snapshot, filtered by the step's
// memoryScope and ranked (G2); 4 selected files read from the `input_file` snapshot artifacts (the live disk is used
// only for the stale check); 5 the upstream structured outputs the step needs (§7.7); 6 token count; 7 G1b fit
// (optional items dropped whole, never truncated); 8 the manifest (G4).
import { INPUT_CAPS, OUTPUT_SCHEMAS, err, errors, ok } from '@relay/contracts';
import type {
  AppError,
  ArtifactId,
  FindingsV1,
  ModelOutputSchemaId,
  OutputSchemaId,
  PatchV1,
  PlanV1,
  RelPath,
  Result,
  ReviewV1,
  Sha256,
  StepKey,
  ValidationIssue,
} from '@relay/contracts';
import type { Db, MemoryItem as StoredMemoryItem, Repos, RunRow, StepRow } from '@relay/storage';
import type { ArtifactStore, ProjectRoot } from '@relay/tools';
import type { TemplateRegistry } from '@relay/templates';
import { canonicalJson, fromUtf8 } from './hash.js';
import { buildManifest, computeContextHash, sha256Text } from './manifest.js';
import type { ManifestInput } from './manifest.js';
import { excessRunSummaries, scoreRecord, stepMemory, tokenize } from './memory-retrieval.js';
import type { RankedRecord, RetrievableRecord } from './memory-retrieval.js';
import type { AssembleInput, AssembledContext, ContextAssemblerPort, MemoryServicePort, ModelStepSnapshot, ProjectFsPort } from './ports.js';
import {
  renderConstraints,
  renderDiffBlock,
  renderFileBlock,
  renderGoal,
  renderIssuesBlock,
  renderRulesBlock,
  renderTaskDocument,
  renderUpstreamBlock,
} from './prompt-render.js';
import { snapshotOf } from './snapshot.js';
import type { FitItem, TokenEstimator } from './token-budget.js';
import { createLocalEstimator, fitToBudget, inputBudget, localTokens } from './token-budget.js';

/** Dependencies of the assembler (07 G1). */
export interface ContextAssemblerDeps {
  readonly db: Db;
  readonly projectFs: ProjectFsPort;
  readonly artifacts: ArtifactStore;
  readonly templates: TemplateRegistry;
  /** Kept for the port signature; the assembler reads the run's memory snapshot directly (taken at intake by G5). */
  readonly memory?: MemoryServicePort;
  readonly estimator?: TokenEstimator;
}

interface SnapshotFile {
  readonly relPath: RelPath;
  readonly sha256: Sha256;
  readonly sizeBytes: number;
  readonly content: string;
}

/** A parsed upstream output and its rendered block. */
interface UpstreamBlock {
  readonly stepKey: StepKey;
  readonly schemaId: OutputSchemaId;
  readonly artifactId: ArtifactId;
  readonly sha256: Sha256;
  readonly block: string;
}

type FileReason = 'selected' | 'plan_scope' | 'referenced_by_findings';

/** Outputs of each step type (07 G1 step 5): review ← none; plan ← findings; implement ← plan + findings; verify ← patch + plan. */
const UPSTREAM: Readonly<Record<ModelOutputSchemaId, readonly ModelOutputSchemaId[]>> = {
  'findings.v1': [],
  'plan.v1': ['findings.v1'],
  'patch.v1': ['plan.v1', 'findings.v1'],
  'review.v1': ['patch.v1', 'plan.v1'],
};

/** Step 1: role instructions from the run's workflow version snapshot (never the live template module). */
function instructions(db: Db, run: RunRow, instructionVersion: string): Result<string> {
  const version = db.repos.workflows.getVersionById(run.workflowVersionId);
  const text = version?.prompts[instructionVersion];
  return text === undefined ? err(errors.modelUnsupported({ reason: 'instructions_missing' })) : ok(text);
}

/** The system prompt: role instructions + the output contract. No dynamic content (cache-stable). */
export function systemPrompt(roleText: string, schemaId: string): string {
  return `${roleText.trimEnd()}\n\nOutput contract: respond with one JSON object that matches the "${schemaId}" schema supplied with this request.`;
}

/** Step 4 (content): every selected file's bytes from its intake snapshot artifact. */
async function readSnapshots(deps: ContextAssemblerDeps, run: RunRow): Promise<Result<SnapshotFile[]>> {
  const out: SnapshotFile[] = [];
  const cache = new Map<ArtifactId, string>();
  for (const f of deps.db.repos.runs.inputFiles(run.id)) {
    let content = cache.get(f.artifactId);
    if (content === undefined) {
      const row = deps.db.repos.artifacts.get(f.artifactId);
      if (row === undefined) return err(errors.notFound('input_file'));
      const read = await deps.artifacts.readSnapshot({ artifactId: f.artifactId, storeRelPath: row.relPath, sha256: f.sha256 });
      if (!read.ok) return read;
      content = read.value.content;
      cache.set(f.artifactId, content);
    }
    out.push({ relPath: f.relPath, sha256: f.sha256, sizeBytes: f.sizeBytes, content });
  }
  return ok(out);
}

/** Opens the project root once per assembly (stale checks only). */
function rootOpener(deps: ContextAssemblerDeps, run: RunRow): () => Promise<Result<ProjectRoot>> {
  let opened: Promise<Result<ProjectRoot>> | undefined;
  return () => {
    opened ??= deps.projectFs.openRoot(deps.db.repos.projects.getWithRoot(run.projectId).rootRealpath);
    return opened;
  };
}

/** Live hashes of `relPaths` (null when the root or the file cannot be hashed). */
async function liveHashes(deps: ContextAssemblerDeps, root: () => Promise<Result<ProjectRoot>>, relPaths: readonly string[]): Promise<Map<string, Sha256 | null> | null> {
  const opened = await root();
  if (!opened.ok) return null;
  const live = await deps.projectFs.hashFiles(opened.value, relPaths);
  return live.ok ? new Map<string, Sha256 | null>(live.value.map((h) => [h.relPath, h.sha256])) : null;
}

/** Step 4 (stale check): live hashes vs the snapshot; any difference → PROJECT_CHANGED. Skipped for preserved runs. */
async function staleCheck(deps: ContextAssemblerDeps, root: () => Promise<Result<ProjectRoot>>, files: readonly SnapshotFile[]): Promise<AppError | null> {
  if (files.length === 0) return null;
  const byPath = await liveHashes(deps, root, files.map((f) => f.relPath));
  if (byPath === null) return errors.projectChanged(files.map((f) => f.relPath));
  const changed = files.filter((f) => byPath.get(f.relPath) !== f.sha256);
  if (changed.length === 0) return null;
  // before/after hashes feed the run inspector's PROJECT_CHANGED panel.
  return errors.projectChanged(changed.map((f) => f.relPath), { details: {
    before: Object.fromEntries(changed.map((f) => [f.relPath, f.sha256])),
    after: Object.fromEntries(changed.map((f) => [f.relPath, byPath.get(f.relPath) ?? null])),
  } });
}

/** The user document sections in their fixed order (G3). Empty sections are dropped. */
export interface DocumentParts {
  readonly goal: string;
  readonly rules?: string;
  readonly upstream?: readonly string[];
  readonly diffBlock: string | null;
  readonly fileBlocks: readonly string[];
  readonly repairBlock: string;
}

/** Renders the user document: goal, constraints, project rules, upstream outputs, imported diff, files, repair. */
export function renderUserDocument(p: DocumentParts): string {
  return renderTaskDocument([renderGoal(p.goal), renderConstraints(), p.rules ?? '', ...(p.upstream ?? []), p.diffBlock ?? '', ...p.fileBlocks, p.repairBlock]);
}

/**
 * The prompt of one model step with every selected file and the step's memory rules, no upstream (preflight
 * estimate, B7). `rules` is the {@link renderStepRules} block of the records the run would snapshot.
 */
export function renderStepPrompt(i: {
  readonly roleText: string;
  readonly schemaId: string;
  readonly goal: string;
  readonly rules?: string;
  readonly diffBlock: string | null;
  readonly files: readonly { readonly relPath: string; readonly sha256: string; readonly content: string }[];
  readonly repairBlock: string;
}): { system: string; user: string } {
  return {
    system: systemPrompt(i.roleText, i.schemaId),
    user: renderUserDocument({ goal: i.goal, ...(i.rules === undefined ? {} : { rules: i.rules }), diffBlock: i.diffBlock, fileBlocks: i.files.map(renderFileBlock),
      repairBlock: i.repairBlock }),
  };
}

/** A live memory record (its current revision) as retrieval sees it: what intake would snapshot right now (preflight). */
export function retrievableOf(item: StoredMemoryItem): RetrievableRecord {
  const sourcePaths = item.current.sourceRefs.flatMap((s) => (s.kind === 'file' ? [s.relPath] : []));
  return { id: item.record.id, revision: item.current.revision, type: item.record.type, title: item.current.title, content: item.current.content,
    pinned: item.record.pinned, scope: item.record.scope, sourcePaths, stale: false };
}

/** The rules block one model step renders from `records` before the token fit: its memoryScope filter + G2 ranking. */
export function renderStepRules(records: readonly RetrievableRecord[], step: Pick<ModelStepSnapshot, 'memoryScope' | 'role'>, goal: string, inputPaths: readonly string[]): string {
  return renderRulesBlock(stepMemory(records, step, { goal, inputPaths }).ranked);
}

/** The imported diff for review/plan steps (07 G3), or null. */
export async function diffBlock(
  deps: Pick<ContextAssemblerDeps, 'db' | 'artifacts'>,
  input: { readonly run: Pick<RunRow, 'input'>; readonly stepSpec: { readonly outputSchema: string } },
): Promise<Result<string | null>> {
  const { run, stepSpec } = input;
  if (run.input.kind !== 'diff' || (stepSpec.outputSchema !== 'findings.v1' && stepSpec.outputSchema !== 'plan.v1')) return ok(null);
  const row = deps.db.repos.artifacts.get(run.input.diffArtifactId);
  if (row === undefined) return err(errors.notFound('input_diff'));
  const bytes = await deps.artifacts.read(row.relPath, INPUT_CAPS.maxDiffBytes);
  if (!bytes.ok) return bytes;
  return ok(renderDiffBlock({ artifactId: row.id, text: fromUtf8(bytes.value) }));
}

/** G3 schema-repair block: issues of the latest prior attempt when this attempt repairs its schema. */
function repairBlock(input: AssembleInput): string {
  if (input.purpose !== 'schema_repair') return '';
  const issues = input.priorAttempts.at(-1)?.error?.details?.['issues'];
  return renderIssuesBlock(Array.isArray(issues) ? (issues as ValidationIssue[]) : []);
}

// ---------------------------------------------------------------- step 5: upstream structured outputs

/**
 * The latest succeeded step row of the run whose output schema is `schemaId`, with `revisionIndex ≤ maxRevision`
 * (and passing `accept`). Shared with the memory service (finalize reads the final plan/review the same way).
 */
export function latestOutputStep(r: Repos, run: Pick<RunRow, 'id' | 'snapshot'>, schemaId: ModelOutputSchemaId, o: {
  readonly maxRevision?: number;
  readonly accept?: (s: StepRow) => boolean;
} = {}): StepRow | undefined {
  const steps = snapshotOf(run).steps;
  const keys = new Set(Object.keys(steps).filter((k) => {
    const s = steps[k];
    return s?.kind === 'model' && s.outputSchema === schemaId;
  }));
  const max = o.maxRevision ?? Number.MAX_SAFE_INTEGER;
  return r.steps.listForRun(run.id)
    .filter((s) => keys.has(s.stepKey) && s.state === 'succeeded' && s.outputArtifactId !== null && s.revisionIndex <= max && (o.accept?.(s) ?? true))
    .sort((a, b) => a.revisionIndex - b.revisionIndex || a.retryIndex - b.retryIndex)
    .at(-1);
}

/** Output values by schema id. */
export interface OutputValues {
  'findings.v1': FindingsV1;
  'plan.v1': PlanV1;
  'patch.v1': PatchV1;
  'review.v1': ReviewV1;
}

/** Reads and parses a step's validated output artifact with the contracts schema (null when it cannot be read). */
export async function readOutput<S extends ModelOutputSchemaId>(
  deps: { readonly db: Db; readonly artifacts: ArtifactStore },
  step: StepRow,
  schemaId: S,
): Promise<{ readonly value: OutputValues[S]; readonly artifactId: ArtifactId; readonly sha256: Sha256 } | null> {
  const row = step.outputArtifactId === null ? undefined : deps.db.repos.artifacts.get(step.outputArtifactId);
  if (row === undefined || row.purgedAt !== null) return null;
  const bytes = await deps.artifacts.read(row.relPath, Math.max(row.sizeBytes, 1));
  if (!bytes.ok) return null;
  try {
    const parsed = OUTPUT_SCHEMAS[schemaId].safeParse(JSON.parse(fromUtf8(bytes.value)));
    return parsed.success ? { value: parsed.data as OutputValues[S], artifactId: row.id, sha256: row.sha256 } : null;
  } catch {
    return null;
  }
}

/** Upstream material for one step: its rendered blocks, plus the plan and findings (file priorities). */
interface Upstream {
  readonly blocks: readonly UpstreamBlock[];
  readonly plan: PlanV1 | null;
  readonly findings: FindingsV1 | null;
}

async function upstreamBlock<S extends ModelOutputSchemaId>(deps: ContextAssemblerDeps, step: StepRow | undefined, schemaId: S, project?: (v: OutputValues[S]) => unknown) {
  if (step === undefined) return null;
  const out = await readOutput(deps, step, schemaId);
  if (out === null) return null;
  const json = canonicalJson(project === undefined ? out.value : project(out.value));
  const block = renderUpstreamBlock({ stepKey: step.stepKey, schemaId, artifactId: out.artifactId, json });
  return { value: out.value, block: { stepKey: step.stepKey, schemaId, artifactId: out.artifactId, sha256: out.sha256, block } };
}

/** Step 5: the structured artifacts the step needs (§7.7, "not an ever-growing transcript"). */
async function loadUpstream(deps: ContextAssemblerDeps, input: AssembleInput): Promise<Upstream> {
  const { run, step, stepSpec } = input;
  const r = deps.db.repos;
  const blocks: UpstreamBlock[] = [];
  let plan: PlanV1 | null = null;
  let findings: FindingsV1 | null = null;
  for (const schemaId of UPSTREAM[stepSpec.outputSchema]) {
    const got = await upstreamBlock(deps, latestOutputStep(r, run, schemaId, { maxRevision: step.revisionIndex }), schemaId);
    if (got === null) continue;
    blocks.push(got.block);
    if (schemaId === 'plan.v1') plan = got.value as PlanV1;
    if (schemaId === 'findings.v1') findings = got.value as FindingsV1;
  }
  if (stepSpec.outputSchema === 'patch.v1' && step.revisionIndex > 0) {
    // Revision block: the verifier's requested changes from the previous cycle (G3).
    const verify = latestOutputStep(r, run, 'review.v1', { maxRevision: step.revisionIndex - 1, accept: (s) => s.outcome === 'revise' });
    const got = await upstreamBlock(deps, verify, 'review.v1', (v) => ({ outcome: v.outcome, requestedChanges: v.requestedChanges }));
    if (got !== null) blocks.push(got.block);
  }
  return { blocks, plan, findings };
}

// ---------------------------------------------------------------- step 3: memory

/**
 * Step 3: the run's memory snapshot (taken once at intake), as retrievable records of this project. Every attribute
 * (revision, title, content, type, pinned, role scope) comes from the snapshot row, never the live record, so a
 * mid-run pin/scope/type edit cannot change this run's context or manifest. The snapshotted revision's (immutable)
 * file source refs feed the stale flag.
 */
async function loadMemory(deps: ContextAssemblerDeps, input: AssembleInput, root: () => Promise<Result<ProjectRoot>>): Promise<RetrievableRecord[]> {
  const r = deps.db.repos;
  const records: RetrievableRecord[] = [];
  const fileRefs: { id: string; relPath: string; sha256: Sha256 }[] = [];
  for (const snap of r.memory.runSnapshot(input.run.id)) {
    if (!snap.included) continue;
    const detail = r.memory.getWithRevisions(snap.recordId);
    // §10.5: project isolation is re-checked here (defense in depth; the snapshot was taken per project).
    if (detail === undefined || detail.item.record.projectId !== input.run.projectId) continue;
    const refs = detail.revisions.find((v) => v.revision === snap.revision)?.sourceRefs ?? [];
    const files = refs.flatMap((s) => (s.kind === 'file' ? [s] : []));
    for (const f of files) fileRefs.push({ id: snap.recordId, relPath: f.relPath, sha256: f.sha256 });
    records.push({ id: snap.recordId, revision: snap.revision, type: snap.type, title: snap.title, content: snap.content, pinned: snap.pinned,
      scope: snap.scope, sourcePaths: files.map((f) => f.relPath), stale: false });
  }
  if (fileRefs.length === 0 || input.preservedSnapshot) return records;
  const live = await liveHashes(deps, root, [...new Set(fileRefs.map((f) => f.relPath))]);
  const stale = new Set(fileRefs.filter((f) => live?.get(f.relPath) !== f.sha256).map((f) => f.id));
  return records.map((m) => (stale.has(m.id) ? { ...m, stale: true } : m));
}

// ---------------------------------------------------------------- step 7: classification + fit

interface FileItem extends SnapshotFile {
  readonly reason: FileReason;
  readonly mandatory: boolean;
  readonly block: string;
  readonly tokens: number;
}

/** relPaths cited by the findings (summary refs + every finding's refs). */
function findingPaths(findings: FindingsV1 | null): Set<string> {
  if (findings === null) return new Set();
  return new Set([...findings.sourceRefs, ...findings.findings.flatMap((f) => f.sourceRefs)].map((s) => s.relPath));
}

/**
 * Step 4 priorities: for implement/verify the approved plan's fileScope is mandatory (`plan_scope`) and the rest are
 * optional, files referenced by findings first, then path order. For other steps every selected file is mandatory.
 */
function classifyFiles(files: readonly SnapshotFile[], schemaId: ModelOutputSchemaId, up: Upstream): FileItem[] {
  const scoped = (schemaId === 'patch.v1' || schemaId === 'review.v1') && up.plan !== null ? new Set(up.plan.fileScope) : null;
  const cited = findingPaths(up.findings);
  return files.map((f) => {
    const block = renderFileBlock(f);
    const tokens = localTokens(block.length + 1);
    if (scoped === null) return { ...f, reason: 'selected', mandatory: true, block, tokens };
    if (scoped.has(f.relPath)) return { ...f, reason: 'plan_scope', mandatory: true, block, tokens };
    return { ...f, reason: cited.has(f.relPath) ? 'referenced_by_findings' : 'selected', mandatory: false, block, tokens };
  });
}

function optionalFileOrder(files: readonly FileItem[]): FileItem[] {
  const rank = (f: FileItem) => (f.reason === 'referenced_by_findings' ? 0 : 1);
  return files.filter((f) => !f.mandatory).sort((a, b) => rank(a) - rank(b) || (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
}

interface MemoryItem extends RankedRecord {
  readonly line: string;
  readonly tokens: number;
}

function ruleLine(m: RankedRecord): string {
  return renderRulesBlock([m]).split('\n')[1] ?? '';
}

/** Everything one assembly renders, before the fit. */
interface Material {
  readonly system: string;
  readonly goal: string;
  readonly upstream: readonly UpstreamBlock[];
  readonly diff: string | null;
  readonly repair: string;
  readonly files: readonly FileItem[];
  readonly memory: readonly MemoryItem[];
}

/** Renders the document with the mandatory items plus the optional items in `extra` (canonical order kept). */
function render(m: Material, extra: ReadonlySet<string>): string {
  const keep = (key: string, mandatory: boolean) => mandatory || extra.has(key);
  const rules = m.memory.filter((x) => keep(`memory:${x.id}`, x.mandatory));
  return renderUserDocument({
    goal: m.goal,
    rules: renderRulesBlock(rules),
    upstream: m.upstream.map((u) => u.block),
    diffBlock: m.diff,
    fileBlocks: m.files.filter((f) => keep(`file:${f.relPath}`, f.mandatory)).map((f) => f.block),
    repairBlock: m.repair,
  });
}

const itemKey = (i: FitItem) => `${i.kind}:${i.ref}`;

/** Step 7: G1b fit, then the estimator count (6); a provider count above the budget drops optional items from the end. */
async function fit(m: Material, estimator: TokenEstimator, input: AssembleInput, budget: number): Promise<Result<{ user: string; included: Set<string>; omitted: FitItem[]; tokens: { tokens: number; basis: 'provider_count' | 'local_estimate' } }>> {
  const mandatoryTokens = localTokens(m.system.length + render(m, new Set()).length);
  const optional: FitItem[] = [
    ...m.memory.filter((x) => !x.mandatory).map((x) => ({ kind: 'memory' as const, ref: x.id, tokens: x.tokens })),
    ...optionalFileOrder(m.files).map((f) => ({ kind: 'file' as const, ref: f.relPath, tokens: f.tokens })),
  ];
  const mandatory = m.files.filter((f) => f.mandatory).map((f) => ({ kind: 'file' as const, ref: f.relPath, tokens: f.tokens }));
  const res = fitToBudget({ budget, mandatoryTokens, mandatory, optional });
  if (!res.ok) return err(tooLarge(res.details));
  const included = [...res.included];
  const omitted = [...res.omitted];
  for (;;) {
    const keys = new Set(included.map(itemKey));
    const user = render(m, keys);
    const count = await estimator.count({ system: m.system, user, profile: input.snapshot });
    if (count.tokens <= budget) return ok({ user, included: keys, omitted, tokens: count });
    const last = included.pop();
    if (last === undefined) return err(tooLarge({ mandatoryTokens: count.tokens, budget, largestItems: largest(mandatory) }));
    omitted.unshift(last);
  }
}

function largest(items: readonly FitItem[]) {
  return [...items].sort((a, b) => b.tokens - a.tokens).slice(0, 5).map((i) => ({ relPath: i.ref, tokens: i.tokens }));
}

function tooLarge(d: { mandatoryTokens: number; budget: number; largestItems: readonly { relPath: string; tokens: number }[] }): AppError {
  return errors.contextTooLarge({ estimatedInputTokens: d.mandatoryTokens, budgetTokens: d.budget }, { details: { ...d } });
}

// ---------------------------------------------------------------- assembly

/**
 * The manifest. Snapshot records the step does not use are listed in `memory` (included: false) and in `omitted` with
 * reason `excluded_by_policy`: those removed by the step's memoryScope / role scope (`policy`) and the run summaries
 * beyond the per-step cap (`excess`).
 */
function manifestOf(m: Material, input: AssembleInput, roleText: string, fitted: { user: string; included: Set<string>; omitted: FitItem[]; tokens: { tokens: number; basis: 'provider_count' | 'local_estimate' } }, extra: { excess: readonly RetrievableRecord[]; policy: readonly RetrievableRecord[]; budget: number }): ManifestInput {
  const { run, step, stepSpec, snapshot: profile } = input;
  const goal = tokenize(run.goal);
  const inputs = new Set(m.files.map((f) => f.relPath));
  const has = (key: string, mandatory: boolean) => mandatory || fitted.included.has(key);
  const unused = [...extra.policy, ...extra.excess];
  return {
    runId: run.id, stepKey: step.stepKey, revisionIndex: step.revisionIndex, attemptPurpose: input.purpose,
    profile: { name: profile.name, providerId: profile.providerId, modelId: profile.modelId },
    priceCatalogVersion: profile.priceCatalogVersion,
    instructions: { version: stepSpec.instructionVersion, sha256: sha256Text(roleText) },
    files: m.files.map((f) => ({ relPath: f.relPath, sha256: f.sha256, sizeBytes: f.sizeBytes, tokens: f.tokens,
      included: has(`file:${f.relPath}`, f.mandatory), reason: f.reason })),
    memory: [
      ...m.memory.map((x) => ({ recordId: x.id, revision: x.revision, type: x.type, included: has(`memory:${x.id}`, x.mandatory), pinned: x.pinned, stale: x.stale, score: x.score })),
      ...unused.map((x) => ({ recordId: x.id, revision: x.revision, type: x.type, included: false, pinned: x.pinned, stale: x.stale, score: scoreRecord(x, goal, inputs) })),
    ],
    upstream: m.upstream.map((u) => ({ stepKey: u.stepKey, artifactId: u.artifactId, schemaId: u.schemaId, sha256: u.sha256 })),
    omitted: [
      ...fitted.omitted.map((o) => ({ kind: o.kind, ref: o.ref, reason: 'token_budget' as const })),
      ...unused.map((x) => ({ kind: 'memory' as const, ref: x.id, reason: 'excluded_by_policy' as const })),
    ],
    tokens: { estimatedInput: fitted.tokens.tokens, budget: extra.budget, basis: fitted.tokens.basis },
    contextHash: computeContextHash(m.system, fitted.user),
    providersReceivingContext: [profile.providerId],
  };
}

async function gather(deps: ContextAssemblerDeps, input: AssembleInput, root: () => Promise<Result<ProjectRoot>>): Promise<Result<{ files: SnapshotFile[]; diff: string | null; up: Upstream; memory: RetrievableRecord[] }>> {
  const files = await readSnapshots(deps, input.run); // 4
  if (!files.ok) return files;
  if (!input.preservedSnapshot) {
    const stale = await staleCheck(deps, root, files.value);
    if (stale !== null) return err(stale);
  }
  const diff = await diffBlock(deps, input);
  if (!diff.ok) return diff;
  const up = await loadUpstream(deps, input); // 5
  const memory = await loadMemory(deps, input, root); // 3
  return ok({ files: files.value, diff: diff.value, up, memory });
}

async function assemble(deps: ContextAssemblerDeps, estimator: TokenEstimator, input: AssembleInput): Promise<Result<AssembledContext>> {
  const { run, stepSpec } = input;
  const role = instructions(deps.db, run, stepSpec.instructionVersion); // 1
  if (!role.ok) return role;
  const root = rootOpener(deps, run);
  const got = await gather(deps, input, root);
  if (!got.ok) return got;
  const { files, diff, up, memory } = got.value;
  const { scoped, ranked } = stepMemory(memory, stepSpec, { goal: run.goal, inputPaths: files.map((f) => f.relPath) }); // 3 (memoryScope) + G2
  const inScope = new Set(scoped.map((x) => x.id));
  const policy = memory.filter((x) => !inScope.has(x.id));
  const material: Material = {
    system: systemPrompt(role.value, stepSpec.outputSchema), // 1
    goal: run.goal, // 2
    upstream: up.blocks,
    diff,
    repair: repairBlock(input),
    files: classifyFiles(files, stepSpec.outputSchema, up),
    memory: ranked.map((m) => {
      const line = ruleLine(m);
      return { ...m, line, tokens: localTokens(line.length + 1) };
    }),
  };
  const budget = inputBudget(input.snapshot, stepSpec.maxOutputTokens);
  const fitted = await fit(material, estimator, input, budget); // 6 + 7
  if (!fitted.ok) return fitted;
  const manifest = buildManifest(manifestOf(material, input, role.value, fitted.value, { excess: excessRunSummaries(scoped, ranked), policy, budget })); // 8
  return ok({ system: material.system, user: fitted.value.user, manifest, estimatedInputTokens: fitted.value.tokens.tokens });
}

/** Creates the context assembler (07 G1, §10.2 steps 1–8). */
export function createContextAssembler(deps: ContextAssemblerDeps): ContextAssemblerPort {
  const estimator = deps.estimator ?? createLocalEstimator();
  return { assemble: (input) => assemble(deps, estimator, input) };
}
