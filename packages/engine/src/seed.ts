// 06 F16: idempotent database seeding — catalog versions, bundled workflow versions (validated, prompts snapshotted),
// and the default profiles. Type-only imports: the catalog and templates are passed in (runtime.ts supplies them).
import { invariant, workflowSpecSchema } from '@relay/contracts';
import type { CatalogModel, Clock, IdGen, ModelParams, ProviderId } from '@relay/contracts';
import type { Db, Repos } from '@relay/storage';
import type { TemplateRegistry, WorkflowSeed } from '@relay/templates';
import { canonicalJson, sha256Hex } from './hash.js';
import { checkProfile, findProfileByName } from './profiles.js';

/** A default profile (§8.2 aliases). */
export interface DefaultProfile {
  readonly name: string;
  readonly providerId: ProviderId;
  readonly modelId: string;
  readonly params: ModelParams;
}

/** Economy / Balanced / Capable (§8.2) + Balanced · OpenAI. Workflow specs reference them by name, case-insensitively. */
export const DEFAULT_PROFILES: readonly DefaultProfile[] = [
  { name: 'Economy', providerId: 'anthropic', modelId: 'claude-haiku-4-5', params: { maxOutputTokens: 8_000, refusalFallback: 'off' } },
  { name: 'Balanced', providerId: 'anthropic', modelId: 'claude-sonnet-5-5', params: { maxOutputTokens: 16_000, effort: 'medium', refusalFallback: 'off' } },
  { name: 'Capable', providerId: 'anthropic', modelId: 'claude-opus-5-5', params: { maxOutputTokens: 32_000, effort: 'high', refusalFallback: 'off' } },
  // The OpenAI counterpart of Balanced (04 §D5 adapter); a run uses it only through a profile override or a switch.
  { name: 'Balanced · OpenAI', providerId: 'openai', modelId: 'gpt-6.1-sol', params: { maxOutputTokens: 8_000, effort: 'medium', refusalFallback: 'off' } },
];

/** Options of {@link seedDatabase}. */
export interface SeedOptions {
  readonly catalog: readonly CatalogModel[];
  readonly templates: Pick<TemplateRegistry, 'seedVersions' | 'prompt'>;
  readonly ids: IdGen;
  readonly clock: Clock;
  readonly profiles?: readonly DefaultProfile[];
}

/** What a seeding call wrote. */
export interface SeedResult {
  readonly catalogEntries: number;
  readonly workflowVersions: number;
  readonly profiles: number;
}

/** `sha256(canonical(spec) + canonical(prompts))` (03 `workflow_versions.content_hash`). */
export function workflowContentHash(spec: unknown, prompts: Readonly<Record<string, string>>): string {
  return sha256Hex(canonicalJson(spec) + canonicalJson(prompts));
}

function latestEntry(entries: readonly CatalogModel[], providerId: ProviderId, modelId: string): CatalogModel | undefined {
  return entries
    .filter((e) => e.providerId === providerId && e.modelId === modelId)
    .reduce<CatalogModel | undefined>((best, e) => (best === undefined || e.catalogVersion > best.catalogVersion ? e : best), undefined);
}

function seedWorkflow(r: Repos, seed: WorkflowSeed, o: SeedOptions): boolean {
  const wf = r.workflows.ensureWorkflow(seed.slug, seed.spec.name);
  if (r.workflows.getVersion(wf.id, seed.version) !== undefined) return false;
  const spec = workflowSpecSchema.parse(seed.spec);
  for (const step of spec.steps) {
    if (step.kind === 'model') invariant(seed.promptsJson[step.instructionVersion] !== undefined, `prompt ${step.instructionVersion} missing`);
  }
  const now = o.clock.now();
  r.workflows.insertVersion({
    id: o.ids.next('workflowVersion'), workflowId: wf.id, version: seed.version, status: 'validated', schemaVersion: spec.schemaVersion,
    spec, prompts: seed.promptsJson, contentHash: workflowContentHash(spec, seed.promptsJson), basedOnVersion: null,
    createdAt: now, validatedAt: now,
  });
  return true;
}

function seedProfile(r: Repos, p: DefaultProfile, o: SeedOptions): boolean {
  if (findProfileByName(r, p.name) !== undefined) return false;
  const entry = latestEntry(o.catalog, p.providerId, p.modelId);
  const checked = checkProfile(p, entry);
  invariant(checked.ok && entry !== undefined, `default profile ${p.name} fails its capability check`);
  const saved = r.profiles.upsert({ id: o.ids.next('profile'), name: p.name, providerId: p.providerId, modelId: p.modelId, params: p.params,
    capabilitiesSnapshot: entry.capabilities, catalogVersion: entry.catalogVersion });
  invariant(saved.ok, `default profile ${p.name} could not be saved`);
  return true;
}

/**
 * Seeds the database in ONE transaction. Idempotent: a second call writes nothing (catalog versions are keyed by
 * version and never edited; existing workflow versions and profiles with the same name are kept).
 * @throws Error when a bundled template or default profile is invalid (a packaging bug).
 */
export function seedDatabase(db: Db, o: SeedOptions): SeedResult {
  return db.tx('immediate', (r) => {
    const catalogEntries = r.catalog.upsertMany(o.catalog);
    const workflowVersions = o.templates.seedVersions().filter((s) => seedWorkflow(r, s, o)).length;
    const profiles = (o.profiles ?? DEFAULT_PROFILES).filter((p) => seedProfile(r, p, o)).length;
    return { catalogEntries, workflowVersions, profiles };
  });
}
