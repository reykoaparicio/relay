# ADR-0017: All money is integer micro-USD

**Status:** Accepted 2026-09-30

## Context

Budget admission and settlement must be exact (spec §9.2, §9.3).

## Decision

Every amount is an integer number of micro-USD (`Microusd`). Ledger balances are derived only from immutable, signed bucket entries.

## Consequences

No floating-point money anywhere. Balances are reproducible from the entry log.

## Revisit when

Multiple currencies or sub-micro-USD prices are needed.
