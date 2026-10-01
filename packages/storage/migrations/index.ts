import { sql as init } from './0001_init.js';
import { sql as indexes } from './0002_indexes.js';

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
];
