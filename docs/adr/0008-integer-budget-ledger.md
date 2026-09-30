# ADR-0008: Integer budget ledger

**Status:** Accepted 2026-09-30

## Context

Reservation and settlement arithmetic must be exact and auditable (spec §9.2, §9.3). Floating-point money is not acceptable.

## Decision

Track budgets with an integer ledger (see ADR-0017 for the micro-USD unit and signed bucket entries).

## Consequences

Arithmetic is exact and testable. Multiple currencies or billing sources are out of scope.

## Revisit when

Multiple currencies or billing sources are added.
