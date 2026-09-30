// 04 §D2: versioned price + capability catalog. Files are static JSON imports (no runtime fs reads, R2-20).
// Adding a catalog version = adding a JSON file under ../catalog AND its import line + CATALOG_FILES entry below.
import { catalogFileSchema } from '@relay/contracts';
import type { CatalogModel, ModelPrices, ProviderId } from '@relay/contracts';
import catalog20260925 from '../catalog/2026-09-25.json' with { type: 'json' };

/** Every statically imported catalog file, oldest first. */
export const CATALOG_FILES: readonly unknown[] = [catalog20260925];

let memo: readonly CatalogModel[] | undefined;

/**
 * Parses every catalog file with the contracts schema and returns all entries (every version), each with the
 * `catalogVersion` of its file header. Memoized. Seeding into `model_catalog` is the engine's job (06 §F16).
 * @throws ZodError on the first call when a catalog file does not match the contracts schema.
 */
export function loadCatalogEntries(): readonly CatalogModel[] {
  memo ??= Object.freeze(
    CATALOG_FILES.flatMap((raw) => {
      const file = catalogFileSchema.parse(raw);
      return file.entries.map((e) => Object.freeze({ ...e, catalogVersion: file.catalogVersion }));
    }),
  );
  return memo;
}

/** The newest catalog version (string compare works for ISO dates). */
export function latestCatalogVersion(): string {
  return loadCatalogEntries().reduce((max, e) => (e.catalogVersion > max ? e.catalogVersion : max), '');
}

/** The newest entry for `(providerId, modelId)`, or `undefined`. */
export function findCatalogEntry(providerId: ProviderId, modelId: string): CatalogModel | undefined {
  let found: CatalogModel | undefined;
  for (const e of loadCatalogEntries()) {
    if (e.providerId !== providerId || e.modelId !== modelId) continue;
    if (found === undefined || e.catalogVersion > found.catalogVersion) found = e;
  }
  return found;
}

/** Cheapest model of a provider in the newest catalog (by input + output price); used for connection tests (FR-02). */
export function cheapestCatalogModel(providerId: ProviderId): CatalogModel | undefined {
  const latest = latestCatalogVersion();
  return loadCatalogEntries()
    .filter((e) => e.providerId === providerId && e.catalogVersion === latest)
    .reduce<CatalogModel | undefined>(
      (best, e) =>
        best === undefined || e.prices.input + e.prices.output < best.prices.input + best.prices.output ? e : best,
      undefined,
    );
}

/**
 * Component-wise maximum of every catalog price of `providerId` (all versions) and `extra`. Used where the model that
 * will be billed is not known up front (ADR-016 refusal fallback), so admission and settlement stay conservative.
 * @returns `undefined` only when neither the catalog nor `extra` carries a price.
 */
export function maxProviderPrices(providerId: ProviderId, ...extra: readonly ModelPrices[]): ModelPrices | undefined {
  const all = [...loadCatalogEntries().filter((e) => e.providerId === providerId).map((e) => e.prices), ...extra];
  const [first, ...rest] = all;
  if (first === undefined) return undefined;
  return rest.reduce<ModelPrices>(
    (max, p) => ({
      input: p.input > max.input ? p.input : max.input,
      output: p.output > max.output ? p.output : max.output,
      cacheRead: p.cacheRead > max.cacheRead ? p.cacheRead : max.cacheRead,
      cacheWrite: p.cacheWrite > max.cacheWrite ? p.cacheWrite : max.cacheWrite,
    }),
    first,
  );
}

const samePrices = (a: ModelPrices, b: ModelPrices): boolean =>
  a.input === b.input && a.output === b.output && a.cacheRead === b.cacheRead && a.cacheWrite === b.cacheWrite;

/**
 * The catalog version that `prices` came from for `(providerId, modelId)`: the explicit `priceCatalogVersion` when
 * the caller passes one (the run's profile snapshot), else the newest entry whose prices equal `prices`, else the
 * newest entry for the model, else the newest catalog version.
 */
export function priceCatalogVersionFor(
  providerId: ProviderId,
  modelId: string,
  prices: ModelPrices,
  explicit?: string,
): string {
  if (explicit !== undefined) return explicit;
  let match: CatalogModel | undefined;
  for (const e of loadCatalogEntries()) {
    if (e.providerId !== providerId || e.modelId !== modelId || !samePrices(e.prices, prices)) continue;
    if (match === undefined || e.catalogVersion > match.catalogVersion) match = e;
  }
  return (match ?? findCatalogEntry(providerId, modelId))?.catalogVersion ?? latestCatalogVersion();
}
