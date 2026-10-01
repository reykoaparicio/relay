// C3 schema (03-storage-db-layer.md), embedded as a TS module (R4-32). Forward-only: never edit after release.
// The SQL must contain no backtick, no dollar-brace, and no backslash (asserted by migrate.test.ts).
export const sql = `
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
  idempotency_key      TEXT NOT NULL UNIQUE,
  created_at           INTEGER NOT NULL,
  started_at           INTEGER,
  ended_at             INTEGER,
  updated_at           INTEGER NOT NULL,
  CHECK ((status IN ('completed','incomplete','cancelled','failed')) = (ended_at IS NOT NULL)),
  CHECK ((status = 'paused') = (pause_reason IS NOT NULL))       -- a paused run always has a reason; no other status has one
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
`;
