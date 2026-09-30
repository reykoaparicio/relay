import { test } from '../fixtures.js';

// 12 §L4 memory.spec (FR-06): suggested record → edit + approve → relaunch (revision 2) → project isolation → delete
// with confirm. The memory.* runner channels are Wave 3 and still answer INTERNAL not_implemented in this build, so
// the journey cannot run yet. Remove the skip once memory.* lands.
test.describe('memory', { tag: '@m3' }, () => {
  // eslint-disable-next-line playwright/no-skipped-test -- Wave 3: memory.* is not implemented yet (see above)
  test.skip(true, 'memory.* is Wave 3: the runner channels are still not_implemented in this build');

  // eslint-disable-next-line playwright/expect-expect -- placeholder until memory.* lands (Wave 3)
  test('suggested → edited + approved → survives relaunch → isolated per project → deleted with confirm', async () => {
    // Implemented in Wave 3 (see the plan table in plans/12-e2e-playwright.md §L4).
  });
});
