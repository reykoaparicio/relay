// Decision 1: an attempt whose outcome is uncertain (dispatch state `unknown`) is settled at once as an `estimated`
// charge instead of waiting in the `unknown` ledger bucket for a user decision.
// `outcome_uncertain` = 1 marks those attempts (the run detail's `uncertainAttempts`, report `estimatedCharges`);
// `may_not_have_been_charged` = 1 when the request may never have reached the provider (not sent, or sent with no
// response byte back). Both 0 for attempts recorded before this migration (the engine converts any legacy unknown
// liability at start and sets them then).
// Forward-only: never edit after release. The SQL must contain no backtick, no dollar-brace, and no backslash.
export const sql = `
ALTER TABLE attempts
  ADD COLUMN outcome_uncertain INTEGER NOT NULL DEFAULT 0 CHECK (outcome_uncertain IN (0,1));
ALTER TABLE attempts
  ADD COLUMN may_not_have_been_charged INTEGER NOT NULL DEFAULT 0 CHECK (may_not_have_been_charged IN (0,1));
`;
