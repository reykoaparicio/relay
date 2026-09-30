// 04 §D9 live smoke (OpenAI Responses API). Runs only with RELAY_LIVE_TESTS=1 and OPENAI_API_KEY in the test env; spends
// real money under RELAY_LIVE_TEST_CAP_MICROUSD (default 100 000 = $0.10). Run manually: RELAY_LIVE_TESTS=1 pnpm test:live
import { systemClock } from '@relay/contracts';
import { createOpenAIAdapter } from '@relay/providers';
import { defineProviderSmoke } from './provider-smoke.js';

defineProviderSmoke('openai', () => createOpenAIAdapter({ clock: systemClock }));
