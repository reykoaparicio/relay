// FR-02 connection test: one tiny structured request (04 §D4 testConnection).
import type { ModelRequest } from './types.js';
import type { ProviderId } from '@relay/contracts';

/** Output allowance for a connection test (04 §D4). */
export const CONNECTION_TEST_MAX_OUTPUT_TOKENS = 16;

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

/** Builds the connection-test request for `modelId`. */
export function connectionTestRequest(providerId: ProviderId, modelId: string): ModelRequest {
  return {
    providerId,
    modelId,
    system: 'Connection test. Answer with the JSON object {"ok": true} and nothing else.',
    messages: [{ role: 'user', content: 'Reply {"ok": true}.' }],
    outputSchema: CONNECTION_TEST_SCHEMA,
    maxOutputTokens: CONNECTION_TEST_MAX_OUTPUT_TOKENS,
    refusalFallback: 'off',
    metadata: { attemptId: 'setup', runId: 'setup', stepKey: CONNECTION_TEST_STEP_KEY, purpose: 'initial' },
  };
}
