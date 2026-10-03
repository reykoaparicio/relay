// E2: where the last provider test result came from. `connection_test` = the user's Settings → Test connection;
// `run` = a model call during a run that failed with AUTH_REQUIRED. The UI words a run-time auth failure differently
// from a failed connection test. NULL for results recorded before this migration (source unknown).
// Forward-only: never edit after release. The SQL must contain no backtick, no dollar-brace, and no backslash.
export const sql = `
ALTER TABLE provider_credential_refs
  ADD COLUMN last_test_source TEXT CHECK (last_test_source IS NULL OR last_test_source IN ('connection_test','run'));
`;
