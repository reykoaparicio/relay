import { sql as init } from './0001_init.js';
import { sql as indexes } from './0002_indexes.js';
import { sql as memoryEventsReview } from './0003_memory_events_review.js';
import { sql as credentialTestSource } from './0004_credential_test_source.js';
import { sql as attemptUncertainEstimate } from './0005_attempt_uncertain_estimate.js';

/** One embedded, forward-only migration (03 §C2). */
export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

/** Ordered migration list. Entries are appended, never edited (checksums are verified on every open). */
export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'init', sql: init },
  { version: 2, name: 'indexes', sql: indexes },
  { version: 3, name: 'memory_events_review', sql: memoryEventsReview },
  { version: 4, name: 'credential_test_source', sql: credentialTestSource },
  { version: 5, name: 'attempt_uncertain_estimate', sql: attemptUncertainEstimate },
];
