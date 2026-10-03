// D1-3: `attempts.lookup_done` = 1 once a provider lookup (F9b reconciliation) gave a definitive answer for an
// uncertain attempt that carried no usage (provider: failed, usage not reported): its estimate is kept, and the
// attempt is never looked up again at a later start. 0 for every attempt recorded before this migration.
// L-1: `run_config_revisions.max_output_tokens` = the step's effective output limit from that revision on (a mid-run
// profile switch to a model with a lower output cap lowers the limit to that cap). NULL for revisions recorded before
// this migration (the run snapshot's limit applies).
// Forward-only: never edit after release. The SQL must contain no backtick, no dollar-brace, and no backslash.
export const sql = `
ALTER TABLE attempts
  ADD COLUMN lookup_done INTEGER NOT NULL DEFAULT 0 CHECK (lookup_done IN (0,1));
ALTER TABLE run_config_revisions
  ADD COLUMN max_output_tokens INTEGER CHECK (max_output_tokens IS NULL OR max_output_tokens > 0);
`;
