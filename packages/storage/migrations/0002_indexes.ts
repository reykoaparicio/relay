// Read-path indexes (improvement review item 1). Forward-only: never edit after release. Every statement is checked
// with EXPLAIN QUERY PLAN in schema.test.ts ("0002 indexes").
// The SQL must contain no backtick, no dollar-brace, and no backslash (asserted by migrate.test.ts).
export const sql = `
-- AttemptRepo.listForRun / getInspectorProjection: SCAN attempts + temp B-tree before.
CREATE INDEX attempts_run_idx ON attempts(run_id, created_at, seq);

-- MemoryRepo.getWithRevisions events: SCAN memory_events + temp B-tree before.
CREATE INDEX memory_events_record_idx ON memory_events(record_id, created_at, id);

-- MemoryRepo.countRunSnapshots: the (run_id, record_id) primary key cannot seek on record_id alone.
CREATE INDEX run_memory_snapshot_record_idx ON run_memory_snapshot(record_id);

-- EventRepo.snapshotBinding: the latest event of one type per run without scanning the run's whole log.
CREATE INDEX run_events_type_idx ON run_events(run_id, type, seq);

-- LedgerRepo.listForProjectWindow (ledger.exportTo for a project month): run entries of one project by time.
CREATE INDEX ledger_project_window_idx ON ledger_entries(project_id, created_at, id) WHERE scope = 'run';
`;
