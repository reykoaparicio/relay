// 04 §D7 (R2-21): fake success fixtures, statically imported (no runtime fs reads). Their patches apply to
// tests/fixtures/sample-api (K1); K's fixtures.int.test.ts verifies that.
import connectionTest from './connection-test.json' with { type: 'json' };
import findingsV1 from './findings.v1.json' with { type: 'json' };
import patchV1 from './patch.v1.json' with { type: 'json' };
import planV1 from './plan.v1.json' with { type: 'json' };
import reviewV1Accept from './review.v1.accept.json' with { type: 'json' };
import reviewV1Revise from './review.v1.revise.json' with { type: 'json' };

/** Fixture name → output value (as a model would return it). */
export const FAKE_FIXTURES: Readonly<Record<string, unknown>> = Object.freeze({
  'findings.v1': findingsV1,
  'plan.v1': planV1,
  'patch.v1': patchV1,
  'review.v1.accept': reviewV1Accept,
  'review.v1.revise': reviewV1Revise,
  'connection-test': connectionTest,
});

/** Contracts output schema id of each fixture (`connection-test` is the `{ ok }` connection schema). */
export const FAKE_FIXTURE_SCHEMAS: Readonly<Record<string, string>> = Object.freeze({
  'findings.v1': 'findings.v1',
  'plan.v1': 'plan.v1',
  'patch.v1': 'patch.v1',
  'review.v1.accept': 'review.v1',
  'review.v1.revise': 'review.v1',
  'connection-test': 'connection-test',
});
