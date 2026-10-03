# Plan 03: Storage & DB Layer (Agent C)

Spec: §6.4, §9.2–9.5, §10.4, §12.1–12.3, §18.4 · Backlog: RLY-005, RLY-009 (persistence half), RLY-015 (tables), RLY-019 (tables) · Waves (00 §3): **Wave 1 / M1** C1–C6 · C7–C8 (backup, purge) are not separately scheduled in 00 §3 and land by Wave 4

Files (exclusive): `packages/storage/src/**`, `packages/storage/migrations/**` (embedded TS modules, see C2)

Consumers: runner process only (sole writer, §6.4). The engine sees only the interfaces in `src/types.ts`. Tests use `openTestDb()`.

---

## C1: SQL driver abstraction (`src/driver.ts`, `src/driver-node-sqlite.ts`)

ADR-012: `node:sqlite` `DatabaseSync` (built into Node 24 / Electron 44). The rest of the package only sees this interface, so `better-sqlite3` v13 can be swapped in if the RC API shifts.

```ts
export interface SqlStatement {
  run(...params: SqlParam[]): { changes: number; lastInsertRowid: number | bigint };
  get<T = unknown>(...params: SqlParam[]): T | undefined;
  all<T = unknown>(...params: SqlParam[]): T[];
}
export type SqlParam = string | number | bigint | null | Uint8Array;
export interface SqlDriver {
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;             // cached by SQL text (Map) — statements are reused
  readonly inTransaction: boolean;                 // node:sqlite `db.isTransaction`
  close(): void;
  backupTo(destPath: string): Promise<void>;       // node:sqlite `backup(db, path)` (async, consistent snapshot §6.4)
  readonly path: string;
}
export function openNodeSqlite(path: string, opts: { readOnly?: boolean }): SqlDriver;
// maps to `new DatabaseSync(path, { readOnly })` — the node:sqlite option name is `readOnly` (camel case)
```

**node:sqlite API notes (verified on Node 24.18.0; re-verify on the pinned Electron 44 Node at C1 start):**
- `new DatabaseSync(path, { readOnly: true })` opens read-only. A write throws `SQLITE_READONLY`.
- `db.isTransaction` exists (boolean). C4 uses it to guard `ROLLBACK`: after a throw, it issues `ROLLBACK` only when `driver.inTransaction` is true, because SQLite may already have rolled back on its own (for example after `SQLITE_FULL`), and a bare `ROLLBACK` would throw and mask the original error.
- `require('node:sqlite').backup` is an async function (used by `backupTo`).
- `PRAGMA trusted_schema = OFF` does **not** break the `CHECK (json_valid(…))` constraints, because `json_valid` is an innocuous built-in. `migrate.test.ts` asserts this by inserting invalid JSON into a `json_valid` column on a connection opened with the C1 pragmas, and expecting `CHECK constraint failed`.

**Day-1 M1 spike (blocking C1):** verify that `node:sqlite` loads and runs the C3 DDL inside an Electron 44 `utilityProcess` (a throwaway, uncommitted script; the result is recorded in ADR-012). If it fails, switch the driver to `better-sqlite3` v13 behind the same `SqlDriver` interface before any repo work starts, and record the switch in ADR-012.

Connection pragmas, applied on open in this order (`src/pragmas.ts`):

```sql
PRAGMA journal_mode = WAL;          -- readers never block the single writer
PRAGMA synchronous = FULL;          -- durability for ledger/checkpoints over speed (§3.3 no corruption)
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
PRAGMA trusted_schema = OFF;
PRAGMA temp_store = MEMORY;
```

After opening, `PRAGMA integrity_check` (quick variant `quick_check`) runs on startup. A failure raises `fatal{code:'INTERNAL'}` with a recovery hint to restore from `backups/`.

## C2: Migrations (`src/migrate.ts`, `migrations/*.ts`)

Migrations are **embedded** as plain TypeScript modules, never read from disk at runtime. This works identically under Node, tsx, Vitest, and the electron-vite runner bundle, and no build step has to copy `.sql` files (08 drops its migrations copy step; its gate asserts the runner bundle contains `CREATE TABLE runs`).

```ts
// migrations/0001_init.ts
export const sql = `
-- (the full C3 DDL)
`;

// migrations/index.ts
import { sql as init } from './0001_init.js';
import { sql as indexes } from './0002_indexes.js';
export interface Migration { readonly version: number; readonly name: string; readonly sql: string }
export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'init', sql: init },
  { version: 2, name: 'indexes', sql: indexes },
  // { version: 3, name: '…', sql: … }  — appended, never edited
];
```

**`0002_indexes` (read-path indexes, 2026-10-01 improvement review).** `0001_init` is never edited (its checksum is verified on open, and the committed demo snapshot and `tests/fixtures/databases/v1-populated.sqlite` are schema-v1 DBs that upgrade through 0002 on open). It adds, each confirmed with `EXPLAIN QUERY PLAN` in `query-plans.test.ts`:

| Index | Serves |
|---|---|
| `attempts_run_idx ON attempts(run_id, created_at, seq)` | `AttemptRepo.listForRun`, the inspector projection (was `SCAN attempts` + temp B-tree) |
| `memory_events_record_idx ON memory_events(record_id, created_at, id)` | `MemoryRepo.getWithRevisions` events |
| `run_memory_snapshot_record_idx ON run_memory_snapshot(record_id)` | `MemoryRepo.countRunSnapshots` (the PK leads with `run_id`) |
| `run_events_type_idx ON run_events(run_id, type, seq)` | `EventRepo.snapshotBinding` (latest event of a type, never a log scan) |
| `ledger_project_window_idx ON ledger_entries(project_id, created_at, id) WHERE scope = 'run'` | `LedgerRepo.listForProjectWindow` (`ledger.exportTo` for a project month) |

- The SQL inside the template literal must contain no backtick, no `${`, and no backslash, so the string is byte-identical to the DDL text. `migrate.test.ts` asserts this for every entry.
- Each migration is applied inside `BEGIN IMMEDIATE … COMMIT`.
- Table `schema_migrations(version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL) STRICT`.
- `migrate(driver, { migrations = MIGRATIONS, clock, backupsDir })` does the following:
  1. Asserts that `migrations` is sorted by `version`, starting at 1 and contiguous.
  2. Verifies the checksum (sha256 hex of the UTF-8 `sql` string) of every applied migration. On a mismatch it throws `MigrationChecksumError` and refuses to start (§18.5 "migration tested").
  3. Applies the pending migrations in order.
  4. Returns `{ from, to }`.
- The `migrations` parameter exists only so tests can pass a modified list. `openDb` always uses `MIGRATIONS`, and there is **no** directory option anywhere in the package.
- **Pre-migration backup:** if there are pending migrations and the DB is non-empty, it calls `backupTo(backups/<ts>-pre-v<to>/relay.sqlite)` first (§6.4, §18.5).
- The runner calls `migrate` **before** sending `ready` (§6.4, "migrations run before the runner accepts work").
- Migrations are **forward-only**. Downgrades are unsupported, and the app refuses to open a DB whose `max(version)` is greater than the app's highest known version.

### Migration 0005 `attempt_uncertain_estimate` (founder decision 1, 2026-10-03)

`ALTER TABLE attempts ADD COLUMN outcome_uncertain INTEGER NOT NULL DEFAULT 0 CHECK (outcome_uncertain IN (0,1))` and
`ADD COLUMN may_not_have_been_charged INTEGER NOT NULL DEFAULT 0 CHECK (may_not_have_been_charged IN (0,1))`. An attempt
whose outcome became uncertain is settled at once as an `estimated` charge (06); these columns record that and whether
the request may never have reached the provider. Older rows read `false` for both (the engine's start-time conversion
of legacy unknown liabilities sets them). `AttemptRow` gains `outcomeUncertain` / `mayNotHaveBeenCharged`;
`AttemptTransitionFields` gains both (set once, with the state CAS); `AttemptRepo` gains `markUncertain(id, mayNot)`,
`listUncertain(runId)` and `listReconcileCandidates()` (`unknown`, plus `abandoned` uncertain attempts with a provider
response id, whose cost can still be corrected); `LedgerRepo` gains `openUnknownLiabilities()` (per attempt, plus the
setup scope as one row). The `unknown` ledger bucket and its entry types stay for history; new data never writes them.
Migrations 0001–0004 are unchanged.

## C3: Schema — `migrations/0001_init.ts` (complete)

The block below is the exact content of the `sql` export in `migrations/0001_init.ts`. All tables are `STRICT`. Timestamps are ms since epoch (UTC). IDs are prefixed ULID `TEXT` (02 §B1). ID format is validated by Zod at the boundary and in the mappers (C5), so the schema carries no id-format `CHECK`s. Enum `CHECK` lists mirror the 02 §B2 arrays, and `schema.test.ts` asserts each list equals its contracts array.

```sql
-- ============ Projects & settings ============
CREATE TABLE projects (
  id                         TEXT PRIMARY KEY,
  name                       TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  root_realpath              TEXT NOT NULL,             -- canonical absolute path; NEVER sent to renderer
  root_display_path          TEXT NOT NULL,             -- "~/code/sample-api"
  exclusions_json            TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(exclusions_json)),
  allowed_provider_ids_json  TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(allowed_provider_ids_json)),
  provider_options_json      TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(provider_options_json)),  -- { openai: { storeResponses } }
  monthly_allowance_microusd INTEGER CHECK (monthly_allowance_microusd IS NULL OR monthly_allowance_microusd >= 0),
  is_demo                    INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0,1)),
  created_at                 INTEGER NOT NULL,
  updated_at                 INTEGER NOT NULL,
  archived_at                INTEGER
) STRICT;
CREATE UNIQUE INDEX projects_root_active_uq ON projects(root_realpath) WHERE archived_at IS NULL;

CREATE TABLE app_settings (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  updated_at INTEGER NOT NULL
) STRICT;

-- ============ Providers, catalog, profiles ============
CREATE TABLE provider_credential_refs (      -- §12.2 ProviderCredentialRef: raw credential NOT here
  id              TEXT PRIMARY KEY,
  provider_id     TEXT NOT NULL UNIQUE,        -- one active key per provider in P0
  storage_mode    TEXT NOT NULL CHECK (storage_mode IN ('os_protected','session')),
  vault_file      TEXT,                        -- 'secrets/crd_….bin' (relative to userData) when os_protected
  redacted_label  TEXT NOT NULL,               -- 'sk-…a1F9'
  last_test_at    INTEGER,
  last_test_ok    INTEGER CHECK (last_test_ok IN (0,1)),
  last_test_code  TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
) STRICT;

CREATE TABLE model_catalog (                   -- §9.2 price catalog, versioned
  provider_id        TEXT NOT NULL,
  model_id           TEXT NOT NULL,
  catalog_version    TEXT NOT NULL,            -- e.g. '2026-09-25'
  display_name       TEXT NOT NULL,
  capabilities_json  TEXT NOT NULL CHECK (json_valid(capabilities_json)),
  prices_json        TEXT NOT NULL CHECK (json_valid(prices_json)),   -- µUSD per MTok by category
  effective_date     TEXT NOT NULL,            -- ISO date the prices take effect
  source             TEXT NOT NULL,            -- https:// pricing URL (catalogEntrySchema.source)
  source_retrieved_at TEXT NOT NULL,           -- ISO date the source was retrieved (catalogEntrySchema.sourceRetrievedAt)
  PRIMARY KEY (provider_id, model_id, catalog_version)
) STRICT;

CREATE TABLE model_profiles (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,
  provider_id  TEXT NOT NULL,
  model_id     TEXT NOT NULL,
  params_json  TEXT NOT NULL CHECK (json_valid(params_json)),
  capabilities_snapshot_json TEXT NOT NULL CHECK (json_valid(capabilities_snapshot_json)), -- §12.2 "capabilities snapshot"
  catalog_version            TEXT NOT NULL,                                                -- catalog used at validation
  revision     INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
) STRICT;

-- ============ Workflows ============
CREATE TABLE workflows (
  id          TEXT PRIMARY KEY,                -- 'wfl_…'
  slug        TEXT NOT NULL UNIQUE,            -- 'review-propose-fix'
  name        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
) STRICT;

CREATE TABLE workflow_versions (
  id               TEXT PRIMARY KEY,           -- 'wfv_…'
  workflow_id      TEXT NOT NULL REFERENCES workflows(id),
  version          INTEGER NOT NULL CHECK (version >= 1),
  status           TEXT NOT NULL CHECK (status IN ('draft','validated')),
  draft_revision   INTEGER NOT NULL DEFAULT 1,  -- optimistic concurrency for drafts
  schema_version   INTEGER NOT NULL,
  spec_json        TEXT NOT NULL CHECK (json_valid(spec_json)),
  prompts_json     TEXT NOT NULL CHECK (json_valid(prompts_json)), -- { "reviewer.v1": "...", ... } exact text snapshot
  content_hash     TEXT NOT NULL,               -- sha256(canonical(spec)+canonical(prompts))
  based_on_version INTEGER,
  created_at       INTEGER NOT NULL,
  validated_at     INTEGER,
  UNIQUE (workflow_id, version)
) STRICT;
CREATE UNIQUE INDEX workflow_one_draft_uq ON workflow_versions(workflow_id) WHERE status = 'draft';
-- §12.2 "Immutable after a run references it": validated versions are immutable, full stop.
CREATE TRIGGER workflow_versions_immutable BEFORE UPDATE ON workflow_versions
WHEN OLD.status = 'validated'
BEGIN SELECT RAISE(ABORT, 'workflow_version is immutable once validated'); END;

-- ============ Runs, steps, attempts ============
CREATE TABLE runs (
  id                   TEXT PRIMARY KEY,
  project_id           TEXT NOT NULL REFERENCES projects(id),
  workflow_version_id  TEXT NOT NULL REFERENCES workflow_versions(id),
  goal                 TEXT NOT NULL CHECK (length(goal) BETWEEN 1 AND 2000),
  status               TEXT NOT NULL CHECK (status IN ('queued','running','awaiting_approval','paused','interrupted',
                                                      'cancelling','cancelled','completed','incomplete','failed')),
  pause_reason         TEXT CHECK (pause_reason IS NULL OR pause_reason IN ('budget_run','budget_project','user','auth_required',
                                'rate_limited','setup_blocked','approval_stale','deadline','limit_attempts','unknown_outcome',
                                'output_invalid','provider_unavailable','budget_overrun','model_refused')),
  status_detail_json   TEXT CHECK (status_detail_json IS NULL OR json_valid(status_detail_json)), -- AppError of last block
  input_json           TEXT NOT NULL CHECK (json_valid(input_json)),       -- RunInput
  snapshot_json        TEXT NOT NULL CHECK (json_valid(snapshot_json)),    -- profiles+capabilities+catalog version per step (FR-03)
  limits_json          TEXT NOT NULL CHECK (json_valid(limits_json)),
  context_hash         TEXT,                                               -- sha256 of intake manifest
  revision_cycle       INTEGER NOT NULL DEFAULT 0 CHECK (revision_cycle >= 0),
  attempt_count        INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  execution_ms_used    INTEGER NOT NULL DEFAULT 0 CHECK (execution_ms_used >= 0), -- §9.1 elapsed EXECUTION time; accrues only while status='running'
  running_since        INTEGER,                                            -- start of the current running segment (null when not running)
  pause_requested      INTEGER NOT NULL DEFAULT 0 CHECK (pause_requested IN (0,1)),  -- 06 F11 durable user pause flag
  deferred_pause       TEXT CHECK (deferred_pause IS NULL OR deferred_pause IN ('budget_overrun','approval_stale')), -- 06 F2 clarification 14
  deferred_pause_detail_json TEXT CHECK (deferred_pause_detail_json IS NULL OR json_valid(deferred_pause_detail_json)), -- its AppError
  idempotency_key      TEXT NOT NULL UNIQUE,
  created_at           INTEGER NOT NULL,
  started_at           INTEGER,
  ended_at             INTEGER,
  updated_at           INTEGER NOT NULL,
  CHECK ((status IN ('completed','incomplete','cancelled','failed')) = (ended_at IS NOT NULL)),
  CHECK ((status = 'paused') = (pause_reason IS NOT NULL)),      -- a paused run always has a reason; no other status has one
  CHECK ((deferred_pause IS NULL) = (deferred_pause_detail_json IS NULL))
) STRICT;
CREATE INDEX runs_project_created_idx ON runs(project_id, created_at DESC, id DESC);
CREATE INDEX runs_active_idx ON runs(status) WHERE status IN ('queued','running','cancelling','awaiting_approval','paused','interrupted');

CREATE TABLE run_input_files (              -- §11.2 hashes for stale detection + pointer to the byte snapshot
  run_id        TEXT NOT NULL REFERENCES runs(id),
  rel_path      TEXT NOT NULL,
  sha256        TEXT NOT NULL,
  artifact_id   TEXT NOT NULL REFERENCES artifacts(id),   -- 'input_file' artifact holding the bytes read at intake (05 E6)
  size_bytes    INTEGER NOT NULL CHECK (size_bytes >= 0),
  captured_at   INTEGER NOT NULL,
  PRIMARY KEY (run_id, rel_path)
) STRICT, WITHOUT ROWID;

CREATE TABLE step_runs (
  id                  TEXT PRIMARY KEY,
  run_id              TEXT NOT NULL REFERENCES runs(id),
  step_key            TEXT NOT NULL,           -- 'review' | 'plan' | 'approve' | 'implement' | 'verify' | 'intake' | 'finalize'
  ordinal             INTEGER NOT NULL,
  revision_index      INTEGER NOT NULL DEFAULT 0 CHECK (revision_index >= 0),  -- 0 first pass; 1..N revision cycles
  retry_index         INTEGER NOT NULL DEFAULT 0 CHECK (retry_index >= 0),     -- 0 first try; +1 per user retry of a failed step (new row)
  state               TEXT NOT NULL CHECK (state IN ('pending','ready','reserved','executing','validating',
                                                     'awaiting_approval','succeeded','failed','unknown','skipped')),
  profile_name        TEXT,                    -- model steps
  input_artifact_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(input_artifact_ids_json)), -- §12.2 input artifact IDs (upstream + context manifest)
  output_artifact_id  TEXT REFERENCES artifacts(id) DEFERRABLE INITIALLY DEFERRED,
  outcome             TEXT,                    -- 'accept' | 'revise' | 'incomplete' for verify; null otherwise
  schema_repairs_used INTEGER NOT NULL DEFAULT 0,
  transport_retries_used INTEGER NOT NULL DEFAULT 0,
  rate_limit_waits_used  INTEGER NOT NULL DEFAULT 0,   -- §7.6 "each consumes a different counter" (survives restart)
  not_before_at       INTEGER,                 -- backoff: the step is not eligible before this time (null = eligible now)
  error_json          TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  UNIQUE (run_id, step_key, revision_index, retry_index)
) STRICT;
CREATE INDEX step_runs_run_idx ON step_runs(run_id, ordinal, revision_index, retry_index);

CREATE TABLE attempts (                     -- §7.3 one row per external attempt
  id                     TEXT PRIMARY KEY,
  run_id                 TEXT NOT NULL REFERENCES runs(id),
  step_run_id            TEXT NOT NULL REFERENCES step_runs(id),
  seq                    INTEGER NOT NULL,              -- per step_run 1..n
  purpose                TEXT NOT NULL CHECK (purpose IN ('initial','transport_retry','schema_repair','user_retry','reconcile')),
  retry_of_attempt_id    TEXT REFERENCES attempts(id),
  provider_id            TEXT NOT NULL,
  model_id               TEXT NOT NULL,
  profile_snapshot_json  TEXT NOT NULL CHECK (json_valid(profile_snapshot_json)),
  request_fingerprint    TEXT NOT NULL,                 -- sha256 of normalized request (no secrets) — idempotency by content
  state                  TEXT NOT NULL CHECK (state IN ('created','reserved','dispatching','succeeded','failed_before_dispatch',
                                                        'failed','unknown','reconciled_succeeded','reconciled_failed','abandoned')),
  reservation_microusd   INTEGER NOT NULL DEFAULT 0 CHECK (reservation_microusd >= 0),
  estimate_json          TEXT CHECK (estimate_json IS NULL OR json_valid(estimate_json)),   -- UsageEstimate (§8.3)
  provider_request_id    TEXT,                          -- SDK _request_id (Anthropic request-id / OpenAI x-request-id)
  provider_response_id   TEXT,                          -- msg_… / resp_… (captured from first stream event)
  usage_json             TEXT CHECK (usage_json IS NULL OR json_valid(usage_json)),         -- NormalizedUsage
  raw_usage_json         TEXT CHECK (raw_usage_json IS NULL OR json_valid(raw_usage_json)), -- redacted original (§8.4)
  price_catalog_version  TEXT NOT NULL,
  stop_reason            TEXT,
  error_json             TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
  created_at             INTEGER NOT NULL,
  dispatched_at          INTEGER,                       -- set in the 'dispatching' transaction (durable intent)
  first_byte_at          INTEGER,
  finished_at            INTEGER,
  UNIQUE (step_run_id, seq)
) STRICT;
CREATE INDEX attempts_unresolved_idx ON attempts(run_id) WHERE state IN ('created','reserved','dispatching','unknown');

-- ============ Ledger (§9) — immutable signed bucket entries ============
CREATE TABLE ledger_entries (
  id                     TEXT PRIMARY KEY,
  scope                  TEXT NOT NULL CHECK (scope IN ('run','setup')),   -- 'setup' = providers.test calls
  run_id                 TEXT REFERENCES runs(id),
  project_id             TEXT REFERENCES projects(id),
  attempt_id             TEXT REFERENCES attempts(id),
  type                   TEXT NOT NULL CHECK (type IN ('allowance_set','allowance_change','reserve','release','settle',
                                                     'move_to_unknown','resolve_unknown')),
  bucket                 TEXT NOT NULL CHECK (bucket IN ('allowance','reserved','settled','unknown')),
  delta_microusd         INTEGER NOT NULL CHECK (delta_microusd BETWEEN -9007199254740991 AND 9007199254740991),
  certainty              TEXT CHECK (certainty IS NULL OR certainty IN ('reported','calculated','estimated','unknown')),
  price_catalog_version  TEXT,
  group_id               TEXT NOT NULL,        -- entries written in the same transaction share a group (atomic moves)
  note                   TEXT,
  created_at             INTEGER NOT NULL,
  CHECK ((scope = 'run') = (run_id IS NOT NULL)),
  CHECK (scope <> 'run' OR project_id IS NOT NULL),          -- run entries always carry their project (project-month balances)
  CHECK (bucket <> 'settled' OR certainty IS NOT NULL)
) STRICT;
CREATE INDEX ledger_run_idx ON ledger_entries(run_id, bucket);
CREATE INDEX ledger_project_idx ON ledger_entries(project_id, bucket, created_at);
CREATE INDEX ledger_setup_idx ON ledger_entries(bucket, created_at) WHERE scope = 'setup';
CREATE INDEX ledger_attempt_idx ON ledger_entries(attempt_id);
CREATE TRIGGER ledger_no_update BEFORE UPDATE ON ledger_entries BEGIN SELECT RAISE(ABORT, 'ledger_entries are immutable'); END;
CREATE TRIGGER ledger_no_delete BEFORE DELETE ON ledger_entries BEGIN SELECT RAISE(ABORT, 'ledger_entries are immutable'); END;

-- Derived balances (§9.3 L, C, R, U) — never stored, always summed
CREATE VIEW run_budget_v AS
SELECT run_id,
  COALESCE(SUM(CASE WHEN bucket='allowance' THEN delta_microusd END),0) AS allowance_l,
  COALESCE(SUM(CASE WHEN bucket='settled'   THEN delta_microusd END),0) AS settled_c,
  COALESCE(SUM(CASE WHEN bucket='reserved'  THEN delta_microusd END),0) AS reserved_r,
  COALESCE(SUM(CASE WHEN bucket='unknown'   THEN delta_microusd END),0) AS unknown_u
FROM ledger_entries WHERE scope='run' GROUP BY run_id;

-- ============ Artifacts ============
CREATE TABLE artifacts (
  id             TEXT PRIMARY KEY,
  run_id         TEXT REFERENCES runs(id),     -- null for imported diff before run start
  project_id     TEXT NOT NULL REFERENCES projects(id),
  step_run_id    TEXT REFERENCES step_runs(id),
  attempt_id     TEXT REFERENCES attempts(id),
  kind           TEXT NOT NULL CHECK (kind IN ('context_manifest','raw_response','findings','plan','patch','review',
                                               'report','memory_suggestions','input_diff','input_file')),
  rel_path       TEXT NOT NULL UNIQUE,          -- 'artifacts/<run|project>/<artifactId>' relative to userData
  sha256         TEXT NOT NULL,
  size_bytes     INTEGER NOT NULL CHECK (size_bytes >= 0),
  media_type     TEXT NOT NULL,
  schema_id      TEXT,                          -- 'plan.v1' etc.
  purged_at      INTEGER,                        -- retention sweep / purge removed the FILE; row + hash kept for audit
  created_at     INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX artifacts_attempt_kind_hash_uq ON artifacts(attempt_id, kind, sha256) WHERE attempt_id IS NOT NULL; -- §7.5 idempotent
CREATE UNIQUE INDEX artifacts_input_file_uq ON artifacts(run_id, sha256) WHERE kind = 'input_file';  -- intake snapshot, deduped per run
CREATE INDEX artifacts_run_idx ON artifacts(run_id, kind);
CREATE TRIGGER artifacts_no_update BEFORE UPDATE OF sha256, rel_path, size_bytes, kind ON artifacts
BEGIN SELECT RAISE(ABORT, 'artifact content is immutable'); END;
-- Purge removes the FILE and sets purged_at (C8); the row and its hash stay for audit.
CREATE TRIGGER artifacts_no_delete BEFORE DELETE ON artifacts
BEGIN SELECT RAISE(ABORT, 'artifacts are never deleted'); END;

-- ============ Approvals (§11.3) ============
CREATE TABLE approvals (
  id                          TEXT PRIMARY KEY,
  run_id                      TEXT NOT NULL REFERENCES runs(id),
  step_run_id                 TEXT NOT NULL REFERENCES step_runs(id),
  plan_artifact_id            TEXT NOT NULL REFERENCES artifacts(id),
  plan_hash                   TEXT NOT NULL,
  context_hash                TEXT NOT NULL,
  file_scope_json             TEXT NOT NULL CHECK (json_valid(file_scope_json)),  -- planned files (approval reuse rule)
  requested_permissions_json  TEXT NOT NULL CHECK (json_valid(requested_permissions_json)),
  decision                    TEXT CHECK (decision IS NULL OR decision IN ('approved','revision_requested','rejected')),
  decision_note               TEXT,
  decided_at                  INTEGER,
  invalidated_at              INTEGER,
  invalidated_reason          TEXT,             -- 'plan_changed' | 'scope_changed' | 'project_changed' | 'provider_changed' (§11.3 new providers)
  created_at                  INTEGER NOT NULL,
  CHECK ((decision IS NULL) = (decided_at IS NULL))
) STRICT;
CREATE INDEX approvals_run_idx ON approvals(run_id, created_at);
CREATE TRIGGER approvals_decided_immutable BEFORE UPDATE OF decision, plan_hash, context_hash, decided_at ON approvals
WHEN OLD.decision IS NOT NULL BEGIN SELECT RAISE(ABORT, 'approval decision is immutable'); END;
CREATE TRIGGER approvals_decided_no_delete BEFORE DELETE ON approvals
WHEN OLD.decision IS NOT NULL BEGIN SELECT RAISE(ABORT, 'decided approvals are never deleted'); END;

-- ============ Memory (§10) ============
CREATE TABLE memory_records (
  id                     TEXT PRIMARY KEY,
  project_id             TEXT NOT NULL REFERENCES projects(id),
  type                   TEXT NOT NULL CHECK (type IN ('user_rule','project_decision','source_reference','run_summary')),
  status                 TEXT NOT NULL CHECK (status IN ('suggested','approved','archived','rejected','deleted')),
  current_revision       INTEGER NOT NULL CHECK (current_revision >= 1),
  scope_json             TEXT NOT NULL CHECK (json_valid(scope_json)),   -- { roles: [...] | "all" }
  pinned                 INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0,1)),
  expires_at             INTEGER,
  review_at              INTEGER,
  superseded_by_id       TEXT REFERENCES memory_records(id),
  source_run_id          TEXT REFERENCES runs(id),
  proposal_json          TEXT CHECK (proposal_json IS NULL OR json_valid(proposal_json)),  -- why reusable, conflicts (§10.4)
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL,
  deleted_at             INTEGER
) STRICT;
CREATE INDEX memory_project_status_idx ON memory_records(project_id, status);   -- §10.5 project id mandatory

CREATE TABLE memory_revisions (
  id               TEXT PRIMARY KEY,
  record_id        TEXT NOT NULL REFERENCES memory_records(id),
  revision         INTEGER NOT NULL CHECK (revision >= 1),
  title            TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  content          TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 4000),
  source_refs_json TEXT NOT NULL CHECK (json_valid(source_refs_json)),   -- [{kind:'file',relPath,sha256}|{kind:'run',runId,artifactId}]
  author           TEXT NOT NULL,                                          -- 'user' | 'run:<runId>'
  created_at       INTEGER NOT NULL,
  UNIQUE (record_id, revision)
) STRICT;
CREATE TRIGGER memory_revisions_immutable BEFORE UPDATE ON memory_revisions
BEGIN SELECT RAISE(ABORT, 'memory revisions are immutable'); END;
CREATE TRIGGER memory_revisions_no_delete BEFORE DELETE ON memory_revisions
BEGIN SELECT RAISE(ABORT, 'memory revisions are never deleted'); END;
-- Revisions are never deleted. A deleted record keeps its revisions but is excluded from retrieval (§10.4).
-- purgeProjectHistory (C8) removes only the per-run snapshot copies. Hard delete of revisions is out of P0.

CREATE TABLE memory_events (                 -- §10.4 "Human approval is a durable event"
  id          TEXT PRIMARY KEY,
  record_id   TEXT NOT NULL REFERENCES memory_records(id),
  event       TEXT NOT NULL CHECK (event IN ('suggested','approved','edited','archived','rejected','deleted','conflict_resolved','unarchived','history_purged')),
  revision    INTEGER NOT NULL,
  actor       TEXT NOT NULL,                  -- 'user' | 'run:<id>'
  detail_json TEXT CHECK (detail_json IS NULL OR json_valid(detail_json)),
  created_at  INTEGER NOT NULL
) STRICT;

CREATE TABLE run_memory_snapshot (          -- which revisions each run used (§4.5, §10.4)
  run_id       TEXT NOT NULL REFERENCES runs(id),
  record_id    TEXT NOT NULL REFERENCES memory_records(id),
  revision     INTEGER NOT NULL,
  title        TEXT NOT NULL,                 -- copied for reproducibility; purged by purgeProjectHistory
  content      TEXT NOT NULL,
  type         TEXT NOT NULL CHECK (type IN ('user_rule','project_decision','source_reference','run_summary')),  -- attributes as of
  pinned       INTEGER NOT NULL CHECK (pinned IN (0,1)),                                                       -- the snapshot: context
  scope_json   TEXT NOT NULL CHECK (json_valid(scope_json)),                                                   -- never reads the live row
  included     INTEGER NOT NULL CHECK (included IN (0,1)),   -- 0 = omitted by token budget (manifest records why)
  PRIMARY KEY (run_id, record_id)
) STRICT;

CREATE TABLE run_config_revisions (          -- §4.3 "recorded attempt/configuration revision"
  run_id                 TEXT NOT NULL REFERENCES runs(id),
  revision               INTEGER NOT NULL CHECK (revision >= 1),
  step_key               TEXT NOT NULL,
  previous_profile_json  TEXT NOT NULL CHECK (json_valid(previous_profile_json)),
  profile_snapshot_json  TEXT NOT NULL CHECK (json_valid(profile_snapshot_json)),
  reason                 TEXT NOT NULL,          -- 'budget_cheaper_profile' | 'model_refused' | 'user_switch'
  created_at             INTEGER NOT NULL,
  PRIMARY KEY (run_id, revision)
) STRICT;
CREATE TRIGGER run_config_revisions_immutable BEFORE UPDATE ON run_config_revisions
BEGIN SELECT RAISE(ABORT, 'config revisions are immutable'); END;
-- The effective profile for a step = latest run_config_revisions row for that step_key, else runs.snapshot_json.

-- ============ Events, idempotency, leases ============
CREATE TABLE run_events (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES runs(id),
  seq         INTEGER NOT NULL,
  type        TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),   -- already redacted
  created_at  INTEGER NOT NULL,
  UNIQUE (run_id, seq)
) STRICT;
CREATE TRIGGER run_events_immutable BEFORE UPDATE ON run_events BEGIN SELECT RAISE(ABORT, 'run_events are immutable'); END;
CREATE TRIGGER run_events_no_delete BEFORE DELETE ON run_events BEGIN SELECT RAISE(ABORT, 'run_events are immutable'); END;

CREATE TABLE idempotency_keys (             -- 02 §B0 idempotency
  op            TEXT NOT NULL,
  key           TEXT NOT NULL,
  request_hash  TEXT NOT NULL,               -- same key + different payload → CONFLICT
  result_json   TEXT NOT NULL CHECK (json_valid(result_json) AND length(result_json) <= 2048),  -- SMALL result: ids + status, never a DTO
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (op, key)
) STRICT;
CREATE INDEX idempotency_created_idx ON idempotency_keys(created_at);

CREATE TABLE runner_lease (                 -- §6.4 single runner ownership
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  owner_id     TEXT NOT NULL,                -- random per runner boot
  pid          INTEGER NOT NULL,
  acquired_at  INTEGER NOT NULL,
  heartbeat_at INTEGER NOT NULL
) STRICT;
```

Deliberately **not** in P0: a `schedules` table. Spec §12.2 says "no active records in P0". YAGNI applies, so migration `migrations/00NN_schedules.ts` will arrive with RLY-028.

`WITHOUT ROWID` is used only for `run_input_files` (small rows, composite text key, always looked up by that key). `idempotency_keys` and `run_memory_snapshot` are ordinary rowid tables: snapshot rows copy memory content (up to 4000 chars) and SQLite advises against `WITHOUT ROWID` for rows over about 1/20 of a page, and `idempotency_keys` gains nothing from it while its `created_at` sweep index works best with a rowid table.

## C4: Unit of work (`src/unit-of-work.ts`)

```ts
type NotPromise<T> = T extends PromiseLike<unknown> ? never : T;
export interface Db {
  readonly repos: Repos;                                        // read access outside tx (autocommit reads)
  tx<T>(mode: 'immediate', fn: (repos: Repos) => NotPromise<T>): T;  // BEGIN IMMEDIATE … COMMIT; ROLLBACK (guarded) on throw
  txResult<T>(mode: 'immediate', fn: (repos: Repos) => NotPromise<Result<T>>): Result<T>; // as tx, but an { ok: false } result ROLLS BACK
  backupTo(dest: string): Promise<void>;
  close(): void;
}
export interface OpenDbOptions {
  path: string; clock: Clock; ids: IdGen; backupsDir: string;
  isPidAlive?: (pid: number) => boolean;    // LeaseRepo dependency (C6); default uses process.kill(pid, 0), EPERM ⇒ alive
}
export function openDb(opts: OpenDbOptions): Promise<Db>;   // opens, applies C1 pragmas, quick_check, migrate(MIGRATIONS)
export function openTestDb(opts?: Partial<OpenDbOptions> & { migrations?: readonly Migration[] })
  : Promise<Db & { path: string; dispose(): Promise<void> }>; // tmpdir file DB, migrated with the embedded MIGRATIONS by default
```

- `NotPromise<T>` makes `db.tx('immediate', async () => …)` a **type error**, which is the compile-time enforcement of §7.4 (gate 00b §2.5).
- Nested `tx` calls throw (`invariant`). There are no savepoints in P0.
- `tx` commits whatever `fn` returns, including an error `Result`. Every engine operation that returns a `Result` from inside a transaction, and whose error path can follow a write, uses `txResult`: an `{ ok: false }` result issues `ROLLBACK` (no partial writes) and is returned unchanged; `{ ok: true }` commits. A throw behaves exactly as in `tx`.
- On a throw inside `fn`, the UoW issues `ROLLBACK` only if `driver.inTransaction` is still true (C1 note), then rethrows the original error.
- `SQLITE_BUSY` after `busy_timeout` maps to `RUNNER_UNAVAILABLE` with retryable=true. It should never happen with a single writer. `unit-of-work.test.ts` proves that `BEGIN IMMEDIATE` really takes the write lock: while connection A holds an open `tx`, a second connection B (same file, `busy_timeout = 50`, same thread) attempts a write and gets `SQLITE_BUSY` (mapped to `RUNNER_UNAVAILABLE`). The test is single-threaded, so it asserts the error rather than waiting for A's commit.

## C5: Row mappers (`src/mappers.ts`)

- The snake_case row is turned into a camelCase domain object with `z.parse`, including the JSON columns. A parse failure throws `DataCorruptionError` with `{table, id}` and is logged as redacted.
- Mappers never return `root_realpath` into renderer DTOs. Projections built for IPC use `root_display_path`, and a type-level test (`expectTypeOf`) enforces this.

## C6: Repositories (`src/repos/*.ts`, interfaces in `src/types.ts`)

Each repo is a factory `createXRepo(driver, deps)` built on prepared statements, with **no business rules**. Business rules live in the engine.

| Repo | Methods (all synchronous) |
|---|---|
| `ProjectRepo` | `insert(p)`, `get(id)`, `getWithRoot(id)` (runner-internal, includes realpath), `findActiveByRoot(rootRealpath)` (the non-archived project at a root, one statement on `projects_root_active_uq`; `projects.createFromRoot`), `list({includeArchived})`, `update(id, patch, expectedUpdatedAt)` → `CONFLICT` on mismatch **or when the project is archived** (archived projects are read-only), `NOT_FOUND` when absent, `archive(id)` (sets `archived_at`; like `update`, writes `updated_at = max(now, current.updated_at + 1)` so `updated_at` strictly increases and a stale `update` CAS can never succeed after an archive), `stats(id, monthStart)` |
| `SettingsRepo` | `get(key)`, `set(key, value)` |
| `CredentialRefRepo` | `upsert(ref)`, `get(providerId)`, `list()`, `delete(providerId)`, `recordTest(providerId, ok, code, at, source)` (`source`: `connection_test` \| `run`, migration 0004) |
| `CatalogRepo` | `upsertMany(entries)`, `get(provider, model, version?)` (latest when version absent), `list(provider?)`, `latestVersion()`. Mapping: `CatalogEntry.displayName` ↔ `display_name`, `prices` ↔ `prices_json`, `capabilities` ↔ `capabilities_json`, `effectiveDate` ↔ `effective_date`, `source` ↔ `source`, `sourceRetrievedAt` ↔ `source_retrieved_at`, `catalogVersion` ↔ `catalog_version` |
| `ProfileRepo` | `list()`, `get(id)`, `getByName(name)`, `upsert(p, expectedRevision?)` (writes `params_json`, `capabilities_snapshot_json`, and `catalog_version` together; the caller passes the capability snapshot it validated against), `delete(id)` |
| `WorkflowRepo` | `ensureWorkflow(slug, name)`, `listSummaries()` (`workflows.list`: each workflow with its latest validated and draft version numbers, one statement), `getVersion(wfId, version \| 'draft')`, `latestValidated(wfId)`, `listVersions(wfId)` (every version, ascending; used by the `profiles.upsert` rename check), `insertVersion(v)`, `updateDraft(wfId, patch, expectedDraftRevision)`, `markValidated(id, at)` |
| `ConfigRevisionRepo` | `append(runId, stepKey, prev, next, reason)` (revision = max+1 in tx), `effectiveProfile(runId, stepKey)`, `list(runId)` |
| `RunRepo` | `insert(run)`, `get(id)`, `list({projectId, statuses, sort, cursor, limit})` using keyset pagination (see below), `updateStatus(id, from[], to, fields)` (**compare-and-set**: `UPDATE … WHERE id=? AND status IN (…)`, returns changed boolean; `fields.pauseReason` is required at the type level when `to = 'paused'` and is written as NULL for every other `to`, matching the `pause_reason` CHECK), `nextQueued()`, `listActive()`, `listTerminalWithoutReport()` (terminal runs with no `report` artifact row, oldest first; 06 F1 step 3 / F17 start sweep), `incrementAttemptCount(id)`, `setRevisionCycle`, `setPauseRequested(id, bool)`, `setDeferredPause(id, {reason, detail} | null)` (06 F2 clarification 14; `RunRow.deferredPause`), `enterRunning(id, now)` (sets `running_since`), `leaveRunning(id, now)` (adds `now − running_since` to `execution_ms_used`, clears it), `insertInputFiles(runId, files: {relPath, sha256, artifactId, sizeBytes, capturedAt}[])`, `replaceInputFiles(runId, files)` (same row shape; one tx: `DELETE` the run's rows + `INSERT` the new set; every `artifact_id` is FK-checked, so a bad row rolls the whole replace back and the old set stays; nothing references `run_input_files` and it has no immutability trigger; the superseded `input_file` artifacts stay as history. Used only by 06 F10 `resnapshot_and_replan`), `inputFiles(runId)` (includes each file's `input_file` artifact id), `getInspectorProjection(runId)` (≤ 6 statements, no N+1; its ledger aggregate also yields `attemptsOverran`, so list rows and the inspector agree on `cost.overrun` without a ledger scan), `listSummaries(q)` (`runs.list` rows: the page + workflow, latest-row step progress, and `RUN_COSTS_SQL` grouped by run id — 4 statements per page whatever its size, never a projection per run), `summariesOf(ids)` (the same aggregates for given runs, in the given order; project export), `idsForProject(projectId)` and `listPausedFor(projectId, pauseReason)` (one statement each, no page limit). `listActive()` uses a literal `status IN (…)` built once from contracts `ACTIVE_RUN_STATUSES` (term-for-term the `runs_active_idx` WHERE, so the partial index is used; a bound `json_each` list cannot match it) |
| `StepRepo` | `insertMany(steps)`, `insertRetry(prev, fields)` (new row with the same `run_id, step_key, revision_index, ordinal`, `retry_index = prev.retry_index + 1`, fresh counters), `get(id)`, `listForRun(runId)`, `latestPerStepKey(runId)` (one row per `step_key`: max `(revision_index, retry_index)`), `latestFor(runId, stepKey)` (`ORDER BY revision_index DESC, retry_index DESC LIMIT 1`), `setNotBefore(id, at \| null)` (eligibility and the earliest `not_before_at` are computed by the engine's pure `selectNextStep` over `latestPerStepKey`; the unused `listEligible` / `earliestNotBefore` were removed), `transition(id, from[], to, fields)` (CAS) |
| `AttemptRepo` | `insert(a)`, `get(id)`, `transition(id, from[], to, fields)` (CAS), `listForStep(stepRunId)`, `countInState(runId, state)` (one COUNT; the F2 action gate's unknown-attempt count), `listUnresolved(runId?)`, `setProviderIds(id, {requestId?, responseId?})` (write-once **per column**: `SET provider_request_id = COALESCE(provider_request_id, ?), provider_response_id = COALESCE(provider_response_id, ?)`, so a later call never overwrites an id and can still fill the other one), `nextSeq(stepRunId)`, and (0005) `markUncertain(id, mayNot)`, `listUncertain(runId)`, `listReconcileCandidates()` |
| `LedgerRepo` | `append(entries[])` (all share `group_id`), `runBalances(runId)` → `{L,C,R,U}` from `run_budget_v`, `projectMonthBalances(projectId, monthStartMs, monthEndMs)` → `{C,R,U}` and `setupBalances(monthStartMs, monthEndMs)` → `{C,R,U}` (semantics below), `attemptBalances(attemptId)` → `{reserved, unknown, settled}`, `list(runId, {sort, cursor, limit})` (keyset on `(created_at, id)`), `runCosts(runId)` → `{balances, settledByCertainty, attemptsOverran}` from ONE `RUN_COSTS_SQL` statement (shared with the projections; `settledByCertainty(runId)` and `attemptsOverran(runId)` — some attempt's `settle` sum exceeds its `reserve` sum, §9.5 — are views of it), `listForRun(runId)` (every entry oldest first with its attempt's step key, one statement; replaces page-draining loops), `listForProjectWindow(projectId, startMs, endMs)` (run entries of the project in `[start, end)`, `created_at, id` order, with step keys; one statement on `ledger_project_window_idx`), and (decision 1) `openUnknownLiabilities()` (legacy liabilities still open; converted at engine start) |
| `ArtifactRepo` | `insertIfAbsent(meta)` → returns the existing row on an `(attempt_id, kind, sha256)` conflict (idempotent §7.5; the raw response and the validated output of one attempt are separate rows even if their bytes match); a replay with the same `id` returns that row only when its `sha256`, `kind`, and `rel_path` match, otherwise `CONFLICT` (as for a `rel_path` already holding other content), `findInputFile(runId, sha256)` (the per-run `input_file` dedupe key), `get(id)`, `listForRun(runId, kinds?)`, `markPurged(id, at)` |
| `ApprovalRepo` | `insert(a)`, `get(id)`, `listForRun(runId)` (every approval of the run, oldest first; 06 F17 report), `pendingForRun(runId)`, `latestApprovedForRun(runId)`, `decide(id, decision, note, at)` (CAS `WHERE decision IS NULL AND invalidated_at IS NULL`), `invalidate(id, reason, at)` |
| `MemoryRepo` | `insertRecord(rec, rev)`, `get(id)`, `getWithRevisions(id)`, `list({projectId, statuses, types, query, sourceRunId})` (**projectId required at type level**, §10.5; `sourceRunId` = records proposed by one run), `retrievable(projectId, role, now)` (approved ∧ not expired ∧ (scope all ∨ role ∈ roles)), `addRevision(recordId, rev, expectedRevision)` (CAS on `current_revision`), `setStatus(id, from[], to, at)`, `recordEvent(e)`, `snapshotForRun(runId, rows)` (each row carries the revision text **and** the record's `type`, `pinned`, and role `scope` at snapshot time), `runSnapshot(runId)`, `purgeRunSnapshots(projectId)` |
| `EventRepo` | `append(runId, type, payload)` (seq = `COALESCE(MAX(seq),0)+1` inside the same tx), `list(runId, afterSeq, limit)`, `lastSeq(runId)`, `snapshotBinding(runId, kinds)` → `{resnapshotSeq, preservedSeq, invalidation}` (one statement of scalar subqueries on `run_events_type_idx`; the payload kinds are the engine's constants), `listForStep(runId, stepRunId, attemptIds)` (events naming the step row or its attempts, filtered in SQL) |
| `IdempotencyRepo` | `get(op, key)`, `put(op, key, requestHash, result: IdempotentResult)`, `sweep(olderThan)` |
| `LeaseRepo` | `acquire(ownerId, pid, now, staleAfterMs)` → `'acquired' \| 'held_by_other'` (rules below), `heartbeat(ownerId, now)` (CAS on owner), `release(ownerId)` |

**Multi-statement writes are atomic.** Every repo method that issues more than one write (`LedgerRepo.append`, `MemoryRepo.insertRecord` (record + first revision), `MemoryRepo.addRevision`, `MemoryRepo.snapshotForRun`, `StepRepo.insertMany`, `RunRepo.insertInputFiles`, `RunRepo.replaceInputFiles`, `CatalogRepo.upsertMany`, `ProjectRepo.archive`, `LeaseRepo.acquire`) runs through `deps.inTx`: it **joins** the caller's transaction when one is open on the connection (so it commits or rolls back with the enclosing `db.tx`), and otherwise opens its own `BEGIN IMMEDIATE … COMMIT` through the UoW (no savepoints). A failing row therefore never leaves a partial group behind.

**Keyset pagination.** Both whitelisted sorts from 02 are supported by the same `(created_at, id)` index:
- `created_desc` (default): `WHERE (created_at, id) < (?, ?) ORDER BY created_at DESC, id DESC LIMIT ?`
- `created_asc`: `WHERE (created_at, id) > (?, ?) ORDER BY created_at ASC, id ASC LIMIT ?`

The cursor is an opaque base64url of `{created_at, id, sort}`. A cursor used with a different `sort` is rejected with `VALIDATION_FAILED`.

**Project-month and setup balances (§9.3).** Month windows are half-open `[monthStartMs, monthEndMs)`.
- `projectMonthBalances(projectId, start, end)` sums `scope = 'run' AND project_id = ?`: `C` = `settled` entries with `created_at` in the window; `R` and `U` = the project's **outstanding** `reserved` and `unknown` totals with **no date filter** (a reservation or unknown liability opened last month still binds this month's allowance until it is released, settled, or resolved).
- `setupBalances(start, end)` applies the same rules to `scope = 'setup'` entries (`providers.test` calls, 06 setup-calls). The setup allowance itself is `SETUP_ALLOWANCE_MICROUSD` / app settings, not a ledger row.
- Both are single aggregate statements (`SUM(CASE …)`), with no business rule. Admission lives in 06.

**Idempotency results are small.** `IdempotentResult = { ids: Record<string, string>; status?: string }` (for example `{ ids: { runId }, status: 'queued' }`). The CHECK caps `result_json` at 2048 bytes. On a replay the engine re-reads the current DTO by those ids instead of returning a stale stored DTO.

**Lease semantics (§6.4).** The lease is **defense in depth**. The primary guarantee is Electron's single-instance lock plus the supervisor, which only forks a runner after the previous child's `exit` event (08 §H6). `acquire` runs in one `BEGIN IMMEDIATE` tx and succeeds (upserting the row with the new owner, pid, and `heartbeat_at = now`) when **any** of these holds:
1. There is no lease row, or the row's `owner_id` equals `ownerId`.
2. The owner PID is dead: the injected `isPidAlive(pid)` returns false. `process.kill(pid, 0)` throwing `ESRCH` means dead; `EPERM` means **alive** (the process exists but belongs to someone else).
3. The heartbeat is stale (`heartbeat_at < now − staleAfterMs`), **regardless of the PID**. A PID can be reused by an unrelated process, so a live PID with a stale heartbeat is not treated as a live runner. The single-instance lock is the primary guard here.

Otherwise (fresh heartbeat **and** live PID) it returns `held_by_other`. An immediate restart after a crash therefore succeeds (fresh heartbeat, dead PID), which the crash tests rely on (11 R4-10).

## C7: Backup & restore (`src/backup.ts`)
- `createBackup({ db, userDataDir, clock })` creates `backups/<YYYYMMDD-HHmmss>/relay.sqlite` via `backupTo`, then opens that **snapshot file read-only** and lists the unpurged artifacts and the schema version **from the snapshot** (never from the live DB, which may have gained or purged artifacts since), and copies those `artifacts/` files. Artifacts are immutable (content-addressed by id+hash), so copying after the DB snapshot is consistent; a file already missing (purged after the snapshot) is skipped and left out of the manifest. It writes a `manifest.json` `{ schemaVersion, createdAt, artifactCount, sha256s }`. Spec §18.4 requires backups with no credentials, so `secrets/` is never copied.
- **There is no `restoreBackup` function** (by design, P0): `backup.ts` exports only `createBackup` (+ its manifest/result types). Restore is a **manual** procedure — quit Relay, replace `relay.sqlite` (and copy the backup's `artifacts/`) from a `backups/<stamp>/` folder — documented in `docs/release/backup-restore.md` (M). K's `backup.int.test.ts` performs that manual copy and reopens the DB. Nothing in the UI or the runner restores.

## C8: Purge & retention (§10.4 "separate project-history purge operation", §12.3 retention)
- `purgeProjectHistory(projectId)` deletes the rows in `run_memory_snapshot` for the project's runs. It then calls `ArtifactStore.purge(relPath)` (05 §E6) for each of those runs' `raw_response` and `context_manifest` artifacts and sets `artifacts.purged_at` (`ArtifactRepo.markPurged`) to the returned `purgedAt`. The store artifacts are `0o444`, so the `chmod 0o644` before the unlink happens **inside** `ArtifactStore.purge`; storage never touches file modes.
  - Artifact rows and hashes stay, because ledger entries and attempts reference them.
  - The immutability trigger covers only `sha256, rel_path, size_bytes, kind`, so updating `purged_at` is allowed.
  - Each affected record gets a `memory_events` row with `event = 'history_purged'`. The ledger is never touched.
  - Purge never deletes `artifacts`, `memory_revisions`, `run_events`, or decided `approvals` rows; C3 `BEFORE DELETE` triggers abort any such delete (an undecided approval may still be deleted).
  - It returns `{ purgedSnapshots, purgedArtifacts, failed }` (`ProjectHistoryPurgeSummary`). A file whose purge fails is counted in `failed`, keeps `purged_at IS NULL`, and is retried by the next purge or sweep; `memory.purgeProjectHistory` returns all three counts (02 output: `purgedArtifacts` / `failed` optional, always sent by the engine).
- `sweepRawResponses(now, retentionDays)` runs at runner boot and then **every 24 h** while the runner lives (06 F1 step 4: `RETENTION_SWEEP_INTERVAL_MS` through the injected `deps.timers.setInterval`, cleared by `engine.stop()`). It purges `raw_response` files older than `app_settings.rawResponseRetentionDays` (default 30) through the same `ArtifactStore.purge` + `markPurged` path.
- Readers check `purged_at` first: a purged artifact returns `{ purged: true, purgedAt }` instead of content (and the store itself answers `NOT_FOUND` with `details.purged = true` if asked for the file). The UI shows "Raw response removed by retention policy (N days)".
- Because file removal and the row update cannot share a transaction, the order is: purge the file, then set `purged_at` in a tx. A crash in between leaves a row whose file is missing; the next sweep sees `purged_at IS NULL`, calls `purge` again (idempotent: a missing file returns the existing tombstone's `purgedAt`), and sets the column.

## Unit tests (owned by C, colocated; all use `openTestDb()`)

| File | Must cover |
|---|---|
| `driver.test.ts` | `openNodeSqlite(path, { readOnly: true })` rejects a write. `inTransaction` is false outside and true inside `BEGIN IMMEDIATE`. The prepared-statement cache returns the same statement for the same SQL. `backupTo` produces an openable file |
| `migrate.test.ts` | Fresh DB → version = latest. Re-running is a no-op. `MIGRATIONS` is contiguous from 1 and no `sql` contains a backtick, `${`, or a backslash. A tampered migration (a test list whose applied `sql` differs by one byte) fails the checksum with `MigrationChecksumError`. A DB with a newer version is refused. A pre-migration backup is created when the DB is non-empty. With the C1 pragmas (`trusted_schema = OFF`), inserting invalid JSON into a `json_valid` column fails with `CHECK constraint failed` and valid JSON succeeds |
| `schema.test.ts` | Every trigger fires: ledger UPDATE/DELETE abort; validated workflow_version UPDATE aborts; decided approval immutable; memory revisions immutable; run_events immutable; config revisions immutable. `BEFORE DELETE` aborts on `run_events`, `memory_revisions`, `artifacts`, and decided `approvals` (an undecided approval deletes). `CHECK`s: terminal status without `ended_at` rejected; `paused` without `pause_reason` rejected, non-paused with a reason rejected, unknown reason rejected; ledger `scope='run'` without `project_id` rejected, `scope='setup'` with `run_id` rejected; `idempotency_keys.result_json` over 2048 bytes rejected. Unique keys: two `step_runs` rows differing only in `retry_index` accepted, an exact duplicate rejected; artifacts with the same `(attempt_id, sha256)` but different `kind` accepted, a duplicate `(attempt_id, kind, sha256)` rejected; a second `input_file` with the same `(run_id, sha256)` rejected. Every enum CHECK list equals its 02 contracts array (including `input_file` and all 14 pause reasons). FK violation raises. The table list equals the C3 list |
| `unit-of-work.test.ts` | Rollback on throw leaves no rows. The ROLLBACK guard: an error after SQLite has already ended the tx surfaces the original error, not "cannot rollback". Nested tx throws. **Type test:** `// @ts-expect-error` on an async callback. **Busy:** while connection A holds an open immediate `tx`, connection B (same file, `busy_timeout = 50`, same thread) fails a write with `SQLITE_BUSY` → `RUNNER_UNAVAILABLE` (retryable) |
| `pragmas.test.ts` | The C1 pragmas are in effect, read back on a real file connection: `journal_mode = wal`, `synchronous = 2` (FULL), `foreign_keys = 1`, `busy_timeout = 5000`, `trusted_schema = 0`, `temp_store = 2` (MEMORY); a bare connection lacks the per-connection ones (`busy_timeout`, `temp_store`) while WAL persists in the file; the pragma order |
| `mappers.test.ts` | `RowReader` throws `DataCorruptionError` with table, id, and column (never content); each scalar / JSON column kind is validated; SQLite result-code classification; `quickCheck` failure → fatal INTERNAL with the restore hint; backup stamps are UTC |
| `maintenance.test.ts` | C8: `purgeProjectHistory` removes the snapshot rows and purges the raw responses and manifests with `history_purged` memory events, ledger untouched; `sweepRawResponses` purges only files older than the window |
| `run-state-repo.test.ts` | `RunRepo.setDeferredPause` stores reason + detail, overwrites, clears with null, survives a status CAS; `LedgerRepo.attemptsOverran` is false at X = N, true at X > N, per attempt and per run (and agrees with `getInspectorProjection().attemptsOverran`), not for an unknown accepted at N; `RunRepo.listTerminalWithoutReport` (06 F17 start sweep); `ApprovalRepo.listForRun` (06 F17 report) |
| `misc-repos.test.ts` | `ProjectRepo` (never exposes `root_realpath`, CAS update, archive monotonic `updated_at`, dashboard stats), `SettingsRepo`, `CredentialRefRepo`, `CatalogRepo` (immutable versions, all-or-nothing `upsertMany`), `WorkflowRepo` drafts, `ConfigRevisionRepo`, `ApprovalRepo` CAS decide / pending / latest approved, `EventRepo` per-run seq |
| `run-repo.test.ts` | Keyset pagination is stable with equal `created_at` (tie-break on id) for **both** `created_desc` and `created_asc`, and paging through all rows yields each exactly once. A cursor from one sort used with the other → `VALIDATION_FAILED`. `updateStatus` CAS returns false when `from` doesn't match, and clears `pause_reason` when leaving `paused`. `enterRunning`/`leaveRunning` accrue `execution_ms_used`. `setPauseRequested` round-trips. `getInspectorProjection` issues ≤ 6 statements (spy on driver.prepare+run) |
| `step-repo.test.ts` | `insertRetry` creates `retry_index + 1` with fresh counters. `latestFor` and `latestPerStepKey` return the max `(revision_index, retry_index)` (a revision beats a retry of an older revision). `setNotBefore` writes and clears `not_before_at` |
| `read-paths.test.ts` | `listSummaries` agrees with `getInspectorProjection` (+ latest-row progress) for every row of a varied fixture (overrun, unknown liability, mixed certainty, retries, a revision, an empty run, skipped steps) in 4 statements per page; `summariesOf` order; `idsForProject` / `listPausedFor` past 100 rows in one statement each; `ledger.listForRun` equals the drained keyset pages + per-run step keys; `listForProjectWindow` window edges, scope and project filters; `snapshotBinding` and `listForStep`; `findActiveByRoot`; `workflows.listSummaries`; `memory.list({ sourceRunId })` |
| `query-plans.test.ts` | `EXPLAIN QUERY PLAN` of the repo statements: each 0002 index is used (no temp B-tree where the index orders), `snapshotBinding` never scans `run_events`, `listActive` uses `runs_active_idx` |
| `attempt-repo.test.ts` | `setProviderIds` fills each column once: a second call with a different response id leaves the first, while a later call can still fill a missing request id. `nextSeq` increments per step run |
| `ledger-repo.test.ts` | `runBalances` sums buckets correctly for reserve → settle, reserve → move_to_unknown, and allowance_change. Negative remaining is allowed (overrun). `projectMonthBalances`: a settle at `monthStart` counts, a settle at `monthEnd` does not (half-open); a reservation created **last month** and still open counts in `R`; an unknown from last month counts in `U`; entries of another project are excluded. `setupBalances` follows the same rules over `scope='setup'` only and ignores run entries |
| `artifact-repo.test.ts` | `insertIfAbsent` twice with the same `(attempt, kind, sha)` returns the same id (idempotent §7.5). The same sha with a different kind creates a second row. `findInputFile` finds the per-run dedupe row. `markPurged` sets `purged_at` (allowed by the immutability trigger) |
| `profile-repo.test.ts` | `upsert` persists `capabilities_snapshot_json` and `catalog_version`, and bumps `revision`. A stale `expectedRevision` → `CONFLICT` |
| `memory-repo.test.ts` | `list` without projectId is a type error (`@ts-expect-error`). `retrievable` excludes suggested/archived/expired/other-project/other-role. `addRevision` CAS conflict |
| `lease-repo.test.ts` | No row → acquired. Same owner → acquired. Fresh heartbeat + alive pid (other owner) → `held_by_other`. **Fresh heartbeat + dead pid → acquired.** **Stale heartbeat + alive pid → acquired** (the single-instance lock is the primary guard). `isPidAlive` treats `EPERM` as alive and `ESRCH` as dead (unit test of the default implementation with a stubbed `process.kill`). `heartbeat` by a non-owner changes nothing |
| `idempotency-repo.test.ts` | Same key+hash returns the stored small result. Same key+different hash → `CONFLICT`. A result over 2048 bytes is rejected. `sweep` removes rows older than the TTL |
| `backup.test.ts` | Backup opens as a valid DB with identical `run_budget_v` output. No `secrets/` in backup |
| `property.ledger.test.ts` (`fast-check`) | For random sequences of reserve/settle/release/move-to-unknown with valid transitions, `R` never goes negative for any attempt, and `C+R+U` equals the sum of the attempts' final states |

## Success Criteria (gate)
- [ ] Day-1 spike recorded in ADR-012: `node:sqlite` loads and runs the C3 DDL inside an Electron 44 `utilityProcess` (or the driver was switched to `better-sqlite3` before repo work)
- [ ] `pnpm typecheck` → exit 0
- [ ] `pnpm test:unit packages/storage --coverage --coverage.include='packages/storage/src/**'` → green, ≥ 90% lines
- [ ] `pnpm lint` → exit 0 (dependency-cruiser: `node:sqlite` imported only in `packages/storage`)
- [ ] `grep -rn "migrationsDir" packages/storage` → no matches, and `grep -n "readFile\|readdir" packages/storage/src/migrate.ts packages/storage/migrations/*.ts` → no matches (migrations are embedded)
- [ ] `pnpm --filter @relay/tests exec node --conditions=development --import tsx --input-type=module -e "import {openTestDb} from '@relay/storage'; const d=await openTestDb(); console.log(d.repos.ledger.runBalances('run_x')); await d.dispose()"` prints `{ L: 0, C: 0, R: 0, U: 0 }`
- [ ] `schema.test.ts` prints the table list from `sqlite_master` and asserts it equals every table in C3

## Review Checklist
- [ ] Every §12.2 entity has a table (Schedule deferred with reason)
- [ ] All JSON columns are validated both by `CHECK json_valid` and by Zod in mappers
- [ ] Every enum `CHECK` list matches its 02 array (`pause_reason`, `artifacts.kind` incl. `input_file`, states, buckets)
- [ ] No repo method contains policy logic (admission, transitions, approval reuse, backoff timing). Those belong to 06
- [ ] No `await` inside any `tx` callback (grep `tx('immediate', async` = 0)
- [ ] `root_realpath` never appears in a type exported for IPC
- [ ] `idempotency_keys.result_json` holds ids + status only, never a DTO
- [ ] No `migrationsDir` option or runtime migration file read anywhere; `openDb`/`openTestDb` signatures match C4

## Addendum E2 (resilience fixes, 2026-10-02)

- `busy_timeout` is `BUSY_TIMEOUT_MS = 200` (was 5000): synchronous node:sqlite must never block the runner's event
  loop long enough to miss heartbeats. A lock that outlasts it is `DATABASE_UNAVAILABLE` `database_busy` (retryable,
  next action `wait`). The engine retries queries asynchronously (`QUERY_BUSY_RETRY_DELAYS_MS`), backs the run loop off
  instead of failing the run, and skips a heartbeat that meets a lock.
- `openDb` retries a lock at boot (`OPEN_BUSY_RETRY_DELAYS_MS`, ~8 s, yielding) and then fails with the boot variant of
  `database_busy` (next action `restart_runner`). Every open failure maps to `DATABASE_UNAVAILABLE` with a closed reason:
  `schema_too_new`, `migration_checksum_mismatch`, `disk_full`, `db_readonly` (write probe at open), `db_corrupt`,
  `integrity_check_failed`, `db_cannot_open`. `fatalInfoOf(err)` (contracts) gives the runner's `fatal {code, reason}`.
- Backups are atomic: written to `<name>.partial/`, renamed after `manifest.json`; a failure removes the partial dir
  (guarded delete). Rolling automatic backups (`Db.autoBackup`, DB-only) go to `<userData>/backups-auto/`, daily, newest 5
  kept. `restoreLatestBackup` (runner-independent, never opens the live DB) restores the newest healthy backup from
  `backups/` + `backups-auto/` and moves the old files to `relay.sqlite.before-restore-<stamp>/`.
- `Db.sizeBytes()` counts the `-wal`. Migration 0003 rebuilds `memory_events` for the `reviewed` / `skipped` events. Migration 0004 adds `provider_credential_refs.last_test_source` (`connection_test` | `run`, NULL for older results; cleared on key replacement). `RunRepo.findByIdempotencyKey(key)` is the one-statement lookup `runs.start` uses on an expired-key insert collision.
- `purgeRunSnapshots` / `purgeProjectHistory` touch only ENDED runs.
