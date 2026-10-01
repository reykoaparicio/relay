// 04 §D10: Gemini price-tier and effort mapping. The catalog prices are the standard tier; anything else is flagged.
import { ThinkingLevel } from '@google/genai';
import type { Effort, ModelCapabilities } from '@relay/contracts';

/** Vertex traffic types billed at the standard (catalog) prices; any other reported type is a price-tier mismatch. */
const STANDARD_TRAFFIC: ReadonlySet<string> = new Set(['ON_DEMAND', 'TRAFFIC_TYPE_UNSPECIFIED']);
/**
 * Gemini Developer API service tiers billed at the standard (catalog) prices (SDK `ServiceTier`: `unspecified` is
 * "default service tier, which is standard"). Compared case-insensitively, tolerating a `SERVICE_TIER_` enum prefix.
 */
const STANDARD_SERVICE_TIERS: ReadonlySet<string> = new Set(['standard', 'unspecified']);

function isStandardServiceTier(tier: string): boolean {
  return STANDARD_SERVICE_TIERS.has(tier.toLowerCase().replace(/^service_tier_/, ''));
}

/**
 * Whether the reported usage says the call was billed other than at the standard tier: a Developer API
 * `usageMetadata.serviceTier` other than standard/unspecified (flex, priority, …), or a Vertex `trafficType` other than
 * on-demand/unspecified.
 */
export function isGeminiPriceTierMismatch(usage: { readonly trafficType?: string; readonly serviceTier?: string } | undefined): boolean {
  if (usage === undefined) return false;
  if (typeof usage.serviceTier === 'string' && !isStandardServiceTier(usage.serviceTier)) return true;
  return typeof usage.trafficType === 'string' && !STANDARD_TRAFFIC.has(usage.trafficType);
}

const THINKING_LEVELS: Readonly<Partial<Record<Effort, ThinkingLevel>>> = {
  low: ThinkingLevel.LOW,
  medium: ThinkingLevel.MEDIUM,
  high: ThinkingLevel.HIGH,
};

/**
 * Maps a Relay effort to a Gemini `thinkingLevel`. Only levels the catalog lists for the model (and Gemini has) are
 * sent; anything else is blocked in capability validation (§8.4), so reaching here with one is a programmer error.
 * @throws Error when `effort` is not supported.
 */
export function mapGeminiEffort(effort: Effort, capabilities: Pick<ModelCapabilities, 'effortLevels'>): ThinkingLevel {
  const level = THINKING_LEVELS[effort];
  if (level === undefined || !capabilities.effortLevels.includes(effort)) throw new Error(`effort ${effort} is not supported by this model`);
  return level;
}
