// 04 §D9/§D10 live smoke for every BYOK adapter (Anthropic, OpenAI, Gemini). Runs only with RELAY_LIVE_TESTS=1 and the provider keys in
// the test env (a provider whose key is absent is skipped with a printed notice). Spends real money under ONE cumulative
// cap for the whole file, RELAY_LIVE_TEST_CAP_MICROUSD (default 100 000 = $0.10): every provider runs in this single file
// so a single LiveBudget sees every call (separate files would run in separate workers with separate totals).
// Run manually: RELAY_LIVE_TESTS=1 pnpm test:live
import { afterAll } from 'vitest';
import { systemClock } from '@relay/contracts';
import { createAnthropicAdapter, createGeminiAdapter, createOpenAIAdapter } from '@relay/providers';
import { createLiveBudget } from './live-budget.js';
import { LIVE, capFromEnv, usd } from './live-env.js';
import { DEFAULT_SMOKE_CAP_MICROUSD, defineProviderSmoke } from './provider-smoke.js';

const budget = createLiveBudget(LIVE ? capFromEnv('RELAY_LIVE_TEST_CAP_MICROUSD', DEFAULT_SMOKE_CAP_MICROUSD) : DEFAULT_SMOKE_CAP_MICROUSD);

afterAll(() => {
  if (LIVE) process.stdout.write(`[live] connection-smoke total: ${usd(budget.spent())} (cap ${usd(budget.cap)})\n`);
});

defineProviderSmoke('anthropic', () => createAnthropicAdapter({ clock: systemClock }), budget);
defineProviderSmoke('openai', () => createOpenAIAdapter({ clock: systemClock }), budget);
// Gemini (04 §D10) shares the same budget; its key comes from GEMINI_API_KEY in the test env and is passed explicitly
// (the adapter never reads GOOGLE_API_KEY / GEMINI_API_KEY itself).
defineProviderSmoke('gemini', () => createGeminiAdapter({ clock: systemClock }), budget);
