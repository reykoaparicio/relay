// 07 G5 — Wave-1 STUB. The memory lifecycle (suggest/approve/archive/conflicts), retrieval, and the memory.* IPC
// handlers land in Wave 3. Until then the service snapshots nothing, proposes nothing, and records no summary, so
// every run's memory snapshot is empty (the context manifest's `memory` is `[]`). The port signature is final.
import { ok } from '@relay/contracts';
import type { Db } from '@relay/storage';
import type { MemoryServicePort } from './ports.js';

/** Dependencies of the (future) memory service. */
export interface MemoryServiceDeps {
  readonly db: Db;
}

/** Creates the Wave-1 memory service stub (no-ops that always succeed). */
/** Creates the Wave-1 stub. G5 (Wave 3) takes {@link MemoryServiceDeps}; the stub needs nothing. */
export function createMemoryService(): MemoryServicePort {
  return {
    snapshotForRun: () => ok(undefined),
    proposeFromRun: () => ok(undefined),
    recordRunSummary: () => ok(undefined),
  };
}
