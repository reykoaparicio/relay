// Decision 3: per-step output limits ("Max output (tokens)") on the New run screen. The engine reports each model
// step's default and allowed range in `runs.preflight` `stepLimits`; until that arrives (or while it belongs to another
// profile choice) the same values are derived locally: the step's spec setting, else the profile's, within
// [MIN_OUTPUT_TOKEN_OVERRIDE, the model's catalog `maxOutputTokens`, else MAX_OUTPUT_TOKENS_CEILING].
import { MAX_OUTPUT_TOKENS_CEILING, MIN_OUTPUT_TOKEN_OVERRIDE } from '@relay/contracts';
import type { CatalogModel, ProfileWithWarnings, RunPreflight } from '@relay/contracts';
import { formatTokensExact } from '../../lib/format';
import type { ModelStepRow } from './model-steps';

/** One step's output limit: the default and the allowed range of an override. */
export interface StepOutputLimit {
  readonly defaultTokens: number;
  readonly min: number;
  readonly max: number;
  /** The chosen model's name ("Claude Haiku 4.5"), for messages; null when the profile is unknown. */
  readonly modelName: string | null;
}

/** The catalog entry of a profile's model, if listed. */
function catalogEntry(
  catalog: readonly CatalogModel[] | undefined,
  profile: ProfileWithWarnings | undefined,
): CatalogModel | undefined {
  if (profile === undefined) return undefined;
  return catalog?.find((c) => c.providerId === profile.profile.providerId && c.modelId === profile.profile.modelId);
}

/** The most output tokens a profile's model can return (catalog), else the contracts ceiling. */
export function modelMaxOutput(catalog: readonly CatalogModel[] | undefined, profile: ProfileWithWarnings | undefined): number {
  return Math.min(catalogEntry(catalog, profile)?.capabilities.maxOutputTokens ?? MAX_OUTPUT_TOKENS_CEILING, MAX_OUTPUT_TOKENS_CEILING);
}

/** A profile's model name for messages: the catalog display name, else the model id. */
export function modelName(catalog: readonly CatalogModel[] | undefined, profile: ProfileWithWarnings | undefined): string | null {
  if (profile === undefined) return null;
  return catalogEntry(catalog, profile)?.displayName ?? profile.profile.modelId;
}

/**
 * stepKey → output limit for every row, in row order. `stepLimits` (preflight) wins when given: pass it only while
 * the preflight answer belongs to the current profile choice.
 */
export function stepOutputLimits(args: {
  readonly rows: readonly ModelStepRow[];
  readonly selection: Readonly<Record<string, string>>;
  readonly profiles: readonly ProfileWithWarnings[] | undefined;
  readonly catalog: readonly CatalogModel[] | undefined;
  readonly stepLimits: RunPreflight['stepLimits'] | undefined;
}): Record<string, StepOutputLimit> {
  const out: Record<string, StepOutputLimit> = {};
  for (const row of args.rows) {
    const profileId = args.selection[row.stepKey] ?? row.defaultProfileId;
    const profile = args.profiles?.find((p) => p.profile.id === profileId);
    const server = args.stepLimits?.find((l) => l.stepKey === row.stepKey);
    const max = server?.modelMaxOutputTokens ?? modelMaxOutput(args.catalog, profile);
    const local = row.maxOutputTokens ?? profile?.profile.params.maxOutputTokens ?? max;
    out[row.stepKey] = {
      defaultTokens: server?.defaultMaxOutputTokens ?? Math.min(local, max),
      min: server?.minMaxOutputTokens ?? MIN_OUTPUT_TOKEN_OVERRIDE,
      max,
      modelName: modelName(args.catalog, profile),
    };
  }
  return out;
}

/** "256–64,000": the allowed range, shown as the field hint. */
export function outputRangeText(limit: Pick<StepOutputLimit, 'min' | 'max'>): string {
  return `${formatTokensExact(limit.min)}–${formatTokensExact(limit.max)}`;
}

/** A step's override text, or a plain-language error (whole number within the step's range). */
export function checkOutputTokens(text: string, limit: StepOutputLimit): { value: number } | { error: string } {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed))
    return { error: `Enter a whole number from ${formatTokensExact(limit.min)} to ${formatTokensExact(limit.max)}.` };
  const value = Number.parseInt(trimmed, 10);
  if (value < limit.min) return { error: `Must be at least ${formatTokensExact(limit.min)}.` };
  if (value > limit.max)
    return {
      error:
        limit.modelName === null
          ? `Must be at most ${formatTokensExact(limit.max)}.`
          : `Must be at most ${formatTokensExact(limit.max)}, the most ${limit.modelName} can return.`,
    };
  return { value };
}

/** The user changed this step's value from its default (an invalid entry counts as changed). */
export function isOutputOverridden(text: string | undefined, limit: StepOutputLimit | undefined): boolean {
  if (text === undefined) return false;
  return limit === undefined || text.trim() !== String(limit.defaultTokens);
}

/**
 * The override text after the step moves to a model that returns at most `max` tokens: a whole number above it is
 * lowered to it, with a note; anything else is kept as is.
 */
export function clampOutputText(
  text: string | undefined,
  max: number,
  model: string | null,
): { readonly text: string | undefined; readonly note: string | null } {
  if (text === undefined || !/^\d+$/.test(text.trim()) || Number.parseInt(text.trim(), 10) <= max) return { text, note: null };
  return {
    text: String(max),
    note: `Lowered to ${formatTokensExact(max)}, the most ${model ?? 'this model'} can return.`,
  };
}
