// 04 §D8: provider registry. In fake mode every provider id resolves to a fake adapter that reports the REAL id,
// all sharing one scenario cursor and one call log, so the multi-provider path runs end to end.
import { PROVIDER_IDS } from '@relay/contracts';
import type { Clock, ModelCapabilities, ProviderId } from '@relay/contracts';
import { createAnthropicAdapter } from './anthropic.js';
import { createMemoryCallLog } from './call-log.js';
import { createOpenAIAdapter } from './openai.js';
import type { FakeCallLog } from './call-log.js';
import { createFakeProvider, createFakeScriptState } from './fake.js';
import { FAKE_SCENARIOS } from './fake-scenarios.js';
import type { FakeScenario } from './fake-scenarios.js';
import { NOOP_LOGGER } from './safe-hook.js';
import type { Logger, ProviderAdapter, Timers } from './types.js';

/** Options of {@link createProviderRegistry}. Fake options are ignored in live mode. */
export interface ProviderRegistryOptions {
  readonly mode: 'live' | 'fake';
  /** FAKE_SCENARIOS key or an inline scenario; default 'happy-path'. */
  readonly fakeScenario?: string | FakeScenario;
  readonly clock: Clock;
  /** Passed to fake adapters (delayMs / hang); default global timers. */
  readonly timers?: Timers;
  readonly callLog?: FakeCallLog;
  readonly fakeCapabilityOverrides?: Partial<ModelCapabilities>;
  readonly extraFixtures?: Readonly<Record<string, unknown>>;
  readonly logger?: Logger;
}

/** Resolves adapters by provider id. */
export interface ProviderRegistry {
  /** @throws Error when no adapter exists for `providerId` in this mode. */
  get(providerId: ProviderId): ProviderAdapter;
  list(): ProviderId[];
}

/** Live adapters implemented so far (Gemini lands in D10). */
const LIVE_FACTORIES: Partial<Record<ProviderId, (clock: Clock, logger: Logger) => ProviderAdapter>> = {
  // No `fetch` override: adapters read globalThis.fetch at call time (04 §D3), so the no-network guard applies.
  anthropic: (clock, logger) => createAnthropicAdapter({ clock, logger }),
  openai: (clock, logger) => createOpenAIAdapter({ clock, logger }),
};

function resolveScenario(s: string | FakeScenario | undefined): FakeScenario {
  if (s === undefined) return FAKE_SCENARIOS['happy-path'] as FakeScenario;
  if (typeof s !== 'string') return s;
  const found = FAKE_SCENARIOS[s];
  if (found === undefined) throw new Error(`unknown fake scenario: ${s}`);
  return found;
}

function liveRegistry(opts: ProviderRegistryOptions, logger: Logger): ProviderRegistry {
  const cache = new Map<ProviderId, ProviderAdapter>();
  const ids = PROVIDER_IDS.filter((id) => LIVE_FACTORIES[id] !== undefined);
  return {
    list: () => [...ids],
    get: (providerId) => {
      const factory = LIVE_FACTORIES[providerId];
      if (factory === undefined) throw new Error(`no live adapter for provider ${providerId}`);
      let adapter = cache.get(providerId);
      if (adapter === undefined) {
        adapter = factory(opts.clock, logger);
        cache.set(providerId, adapter);
      }
      return adapter;
    },
  };
}

/**
 * Creates the registry.
 * @throws Error when `fakeScenario` names an unknown scenario (fake mode).
 */
export function createProviderRegistry(opts: ProviderRegistryOptions): ProviderRegistry {
  const logger = opts.logger ?? NOOP_LOGGER;
  if (opts.mode === 'live') return liveRegistry(opts, logger);
  const scenario = resolveScenario(opts.fakeScenario);
  const state = createFakeScriptState(scenario);
  const callLog = opts.callLog ?? createMemoryCallLog();
  const adapters = new Map<ProviderId, ProviderAdapter>(
    PROVIDER_IDS.map((providerId) => [
      providerId,
      createFakeProvider({
        providerId,
        scenario,
        state,
        clock: opts.clock,
        callLog,
        logger,
        ...(opts.timers === undefined ? {} : { timers: opts.timers }),
        ...(opts.fakeCapabilityOverrides === undefined ? {} : { capabilityOverrides: opts.fakeCapabilityOverrides }),
        ...(opts.extraFixtures === undefined ? {} : { extraFixtures: opts.extraFixtures }),
      }),
    ]),
  );
  return {
    list: () => [...PROVIDER_IDS],
    get: (providerId) => {
      const adapter = adapters.get(providerId);
      if (adapter === undefined) throw new Error(`unknown provider ${providerId}`);
      return adapter;
    },
  };
}
