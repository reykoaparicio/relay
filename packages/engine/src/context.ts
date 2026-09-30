// 07 G1 — Wave-1 STUB of the context assembler (§10.2). Implements steps 1 (versioned instructions from the run's
// workflow-version prompt snapshot), 2 (goal + immutable constraints), 4 (selected files read from the run's
// `input_file` snapshot artifacts, never the live disk; the live disk is used only for the stale check), 6 (token
// count), and 8 (manifest). Steps 3 (memory), 5 (upstream outputs), and 7 (optional-item fitting) land in Wave 3:
// here memory/upstream are empty and every selected file is mandatory (overflow → CONTEXT_TOO_LARGE).
import { INPUT_CAPS, err, errors, ok } from '@relay/contracts';
import type { AppError, ArtifactId, RelPath, Result, Sha256, ValidationIssue } from '@relay/contracts';
import type { Db, RunRow } from '@relay/storage';
import type { ArtifactStore } from '@relay/tools';
import type { TemplateRegistry } from '@relay/templates';
import { buildManifest, computeContextHash, sha256Text } from './manifest.js';
import type { AssembleInput, AssembledContext, ContextAssemblerPort, MemoryServicePort, ProjectFsPort } from './ports.js';
import { renderConstraints, renderDiffBlock, renderFileBlock, renderGoal, renderIssuesBlock, renderTaskDocument } from './prompt-render.js';
import type { TokenEstimator } from './token-budget.js';
import { createLocalEstimator, inputBudget, localTokens } from './token-budget.js';

/** Dependencies of the assembler (07 G1). */
export interface ContextAssemblerDeps {
  readonly db: Db;
  readonly projectFs: ProjectFsPort;
  readonly artifacts: ArtifactStore;
  readonly templates: TemplateRegistry;
  readonly memory: MemoryServicePort;
  readonly estimator?: TokenEstimator;
}

interface SnapshotFile {
  readonly relPath: RelPath;
  readonly sha256: Sha256;
  readonly sizeBytes: number;
  readonly content: string;
}

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

/** Step 4 (stale check): live hashes vs the snapshot; any difference → PROJECT_CHANGED. Skipped for preserved runs. */
async function staleCheck(deps: ContextAssemblerDeps, run: RunRow, files: readonly SnapshotFile[]): Promise<AppError | null> {
  if (files.length === 0) return null;
  const project = deps.db.repos.projects.getWithRoot(run.projectId);
  const root = await deps.projectFs.openRoot(project.rootRealpath);
  if (!root.ok) return errors.projectChanged(files.map((f) => f.relPath));
  const live = await deps.projectFs.hashFiles(root.value, files.map((f) => f.relPath));
  if (!live.ok) return errors.projectChanged(files.map((f) => f.relPath));
  const byPath = new Map<string, Sha256 | null>(live.value.map((h) => [h.relPath, h.sha256]));
  const changed = files.filter((f) => byPath.get(f.relPath) !== f.sha256);
  if (changed.length === 0) return null;
  // before/after hashes feed the run inspector's PROJECT_CHANGED panel.
  return errors.projectChanged(changed.map((f) => f.relPath), { details: {
    before: Object.fromEntries(changed.map((f) => [f.relPath, f.sha256])),
    after: Object.fromEntries(changed.map((f) => [f.relPath, byPath.get(f.relPath) ?? null])),
  } });
}

/** The prompt of one model step (steps 1, 2, 4 + G3 blocks): shared by the assembler and preflight (B7). */
export function renderStepPrompt(i: {
  readonly roleText: string;
  readonly schemaId: string;
  readonly goal: string;
  readonly diffBlock: string | null;
  readonly files: readonly { readonly relPath: string; readonly sha256: string; readonly content: string }[];
  readonly repairBlock: string;
}): { system: string; user: string } {
  return {
    system: systemPrompt(i.roleText, i.schemaId),
    user: renderTaskDocument([renderGoal(i.goal), renderConstraints(), i.diffBlock ?? '', ...i.files.map(renderFileBlock), i.repairBlock]),
  };
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
  return ok(renderDiffBlock({ artifactId: row.id, text: new TextDecoder('utf-8').decode(bytes.value) }));
}

/** G3 schema-repair block: issues of the latest prior attempt when this attempt repairs its schema. */
function repairBlock(input: AssembleInput): string {
  if (input.purpose !== 'schema_repair') return '';
  const issues = input.priorAttempts.at(-1)?.error?.details?.['issues'];
  return renderIssuesBlock(Array.isArray(issues) ? (issues as ValidationIssue[]) : []);
}

function tooLarge(files: readonly SnapshotFile[], tokens: number, budget: number): AppError {
  const largestItems = files
    .map((f) => ({ relPath: f.relPath, tokens: localTokens(f.content.length) }))
    .sort((a, b) => b.tokens - a.tokens || (a.relPath < b.relPath ? -1 : 1))
    .slice(0, 5);
  return errors.contextTooLarge(
    { estimatedInputTokens: tokens, budgetTokens: budget },
    { details: { mandatoryTokens: tokens, budget, largestItems } },
  );
}

async function assemble(deps: ContextAssemblerDeps, estimator: TokenEstimator, input: AssembleInput): Promise<Result<AssembledContext>> {
  const { run, step, stepSpec, snapshot: profile } = input;
  const role = instructions(deps.db, run, stepSpec.instructionVersion); // 1
  if (!role.ok) return role;
  const files = await readSnapshots(deps, run); // 4
  if (!files.ok) return files;
  if (!input.preservedSnapshot) {
    const stale = await staleCheck(deps, run, files.value);
    if (stale !== null) return err(stale);
  }
  const diff = await diffBlock(deps, input);
  if (!diff.ok) return diff;
  const { system, user } = renderStepPrompt({ // 1 + 2 + 4 (+ G3 blocks)
    roleText: role.value, schemaId: stepSpec.outputSchema, goal: run.goal, diffBlock: diff.value, files: files.value, repairBlock: repairBlock(input),
  });
  const count = await estimator.count({ system, user, profile }); // 6
  const budget = inputBudget(profile, stepSpec.maxOutputTokens);
  if (count.tokens > budget) return err(tooLarge(files.value, count.tokens, budget)); // never truncate a file
  const manifest = buildManifest({ // 8
    runId: run.id,
    stepKey: step.stepKey,
    revisionIndex: step.revisionIndex,
    attemptPurpose: input.purpose,
    profile: { name: profile.name, providerId: profile.providerId, modelId: profile.modelId },
    priceCatalogVersion: profile.priceCatalogVersion,
    instructions: { version: stepSpec.instructionVersion, sha256: sha256Text(role.value) },
    files: files.value.map((f) => ({ relPath: f.relPath, sha256: f.sha256, sizeBytes: f.sizeBytes,
      tokens: localTokens(f.content.length), included: true, reason: 'selected' as const })),
    memory: [],
    upstream: [],
    omitted: [],
    tokens: { estimatedInput: count.tokens, budget, basis: count.basis },
    contextHash: computeContextHash(system, user),
    providersReceivingContext: [profile.providerId],
  });
  return ok({ system, user, manifest, estimatedInputTokens: count.tokens });
}

/** Creates the Wave-1 context assembler (steps 1, 2, 4, 6, 8). */
export function createContextAssembler(deps: ContextAssemblerDeps): ContextAssemblerPort {
  const estimator = deps.estimator ?? createLocalEstimator();
  return { assemble: (input) => assemble(deps, estimator, input) };
}
