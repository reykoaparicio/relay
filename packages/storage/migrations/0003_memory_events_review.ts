// E2 #15/#16: two new memory event types, `reviewed` ("Confirm still accurate" re-hashes the file source refs) and
// `skipped` (a run's intake dropped a record that was no longer approved). SQLite cannot alter a CHECK constraint, so
// memory_events is rebuilt (nothing references it; its rows and its index are carried over unchanged).
// Forward-only: never edit after release. The SQL must contain no backtick, no dollar-brace, and no backslash.
export const sql = `
CREATE TABLE memory_events_v3 (
  id          TEXT PRIMARY KEY,
  record_id   TEXT NOT NULL REFERENCES memory_records(id),
  event       TEXT NOT NULL CHECK (event IN ('suggested','approved','edited','archived','rejected','deleted','conflict_resolved','unarchived','history_purged','reviewed','skipped')),
  revision    INTEGER NOT NULL,
  actor       TEXT NOT NULL,
  detail_json TEXT CHECK (detail_json IS NULL OR json_valid(detail_json)),
  created_at  INTEGER NOT NULL
) STRICT;
INSERT INTO memory_events_v3 (id, record_id, event, revision, actor, detail_json, created_at)
  SELECT id, record_id, event, revision, actor, detail_json, created_at FROM memory_events;
DROP TABLE memory_events;
ALTER TABLE memory_events_v3 RENAME TO memory_events;
CREATE INDEX memory_events_record_idx ON memory_events(record_id, created_at, id);
`;
