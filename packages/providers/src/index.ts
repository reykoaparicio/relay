// Public API of @relay/providers (04). Provider SDK types never appear in these exports (§8.3).
export type {
  DispatchPhase,
  EstimateContext,
  FallbackInfo,
  GenerateContext,
  GenerateHooks,
  Logger,
  ModelError,
  ModelRefused,
  ModelRequest,
  ModelResult,
  ModelSuccess,
  ModelTruncated,
  NormalizedUsage,
  ProviderAdapter,
  ReconciliationResult,
  ResultFlags,
  ServedIteration,
  Timers,
  UsageEstimate,
} from './types.js';
export {
  cheapestCatalogModel,
  findCatalogEntry,
  latestCatalogVersion,
  loadCatalogEntries,
  maxProviderPrices,
  priceCatalogVersionFor,
} from './catalog.js';
export { INPUT_SPLIT_ROUNDING_SLACK_MICROUSD, computeCost, computeIterationsCost, upperBound } from './pricing.js';
export type { CalculatedCost, IterationsCost } from './pricing.js';
export { LOCAL_REQUEST_OVERHEAD_TOKENS, conservativeInputTokens, localTokenEstimate } from './estimate.js';
export { normalizeAnthropicUsage, normalizeGeminiUsage, normalizeOpenAIUsage } from './usage.js';
export {
  CONNECTION_TEST_MAX_OUTPUT_TOKENS,
  CONNECTION_TEST_SCHEMA,
  GEMINI_CONNECTION_TEST_MAX_OUTPUT_TOKENS,
  OPENAI_CONNECTION_TEST_MAX_OUTPUT_TOKENS,
  connectionTestMaxOutputTokens,
  connectionTestRequest,
} from './connection-test.js';
export { createAnthropicAdapter } from './anthropic.js';
export type { AnthropicAdapterOptions } from './anthropic.js';
export {
  OPENAI_SERVICE_TIER,
  createOpenAIAdapter,
  isPriceTierMismatch,
  mapEffort,
  openAISchemaName,
  openAIStoreResponses,
  supportsRequestLookupFor,
} from './openai.js';
export type { OpenAIAdapterOptions } from './openai.js';
export { createGeminiAdapter, isGeminiPriceTierMismatch, mapGeminiEffort } from './gemini.js';
export type { GeminiAdapterOptions } from './gemini.js';
export { assertStrictCompatible, strictSchemaProblems } from './strict-schema.js';
export { createJsonlCallLog, createMemoryCallLog } from './call-log.js';
export type { FakeCall, FakeCallLog, FakeLogEntry, FakeReconcileCall } from './call-log.js';
export { FAKE_MODEL_ID, createFakeProvider } from './fake.js';
export type { FakeProviderOptions } from './fake.js';
export { FAKE_SCENARIOS } from './fake-scenarios.js';
export type { FakeReconcileAnswer, FakeScenario, FakeScriptStep, FakeStepResult } from './fake-scenarios.js';
export { FAKE_FIXTURES } from './fake-fixtures/index.js';
export { createProviderRegistry } from './registry.js';
export type { ProviderRegistry, ProviderRegistryOptions } from './registry.js';
