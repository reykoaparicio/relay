// FR-02 connection test: one tiny structured request (04 §D4 testConnection).
import type { ModelRequest } from './types.js';
import type { ProviderId } from '@relay/contracts';

/** Output allowance for a connection test (04 §D4). */
export const CONNECTION_TEST_MAX_OUTPUT_TOKENS = 16;

/**
 * OpenAI connection-test output allowance (04 §D5). Current OpenAI models always reason, and even the lowest listed effort
 * can spend more than 16 tokens thinking before the `{"ok":true}` answer; 256 lets a low-effort reasoning model finish
 * (the engine still treats a `truncated` answer as a working connection).
 */
export const OPENAI_CONNECTION_TEST_MAX_OUTPUT_TOKENS = 256;

/** The connection-test output allowance for `providerId` (what `testConnection` sends; use it for N). */
export function connectionTestMaxOutputTokens(providerId: ProviderId): number {
  return providerId === 'openai' ? OPENAI_CONNECTION_TEST_MAX_OUTPUT_TOKENS : CONNECTION_TEST_MAX_OUTPUT_TOKENS;
}

/** Step key recorded for connection tests (never a workflow step). */
export const CONNECTION_TEST_STEP_KEY = 'connection-test';

/** Trivial `{ ok: boolean }` schema. */
export const CONNECTION_TEST_SCHEMA: ModelRequest['outputSchema'] = Object.freeze({
  name: 'connection_test',
  jsonSchema: Object.freeze({
    type: 'object',
    properties: { ok: { type: 'boolean' } },
    required: ['ok'],
    additionalProperties: false,
  }),
});

/** Builds the connection-test request for `modelId` (`maxOutputTokens` per {@link connectionTestMaxOutputTokens}). */
export function connectionTestRequest(providerId: ProviderId, modelId: string): ModelRequest {
  return {
    providerId,
    modelId,
    system: 'Connection test. Answer with the JSON object {"ok": true} and nothing else.',
    messages: [{ role: 'user', content: 'Reply {"ok": true}.' }],
    outputSchema: CONNECTION_TEST_SCHEMA,
    maxOutputTokens: connectionTestMaxOutputTokens(providerId),
    refusalFallback: 'off',
    metadata: { attemptId: 'setup', runId: 'setup', stepKey: CONNECTION_TEST_STEP_KEY, purpose: 'initial' },
  };
}
