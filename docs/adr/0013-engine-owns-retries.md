# ADR-0013: The engine owns all retries

**Status:** Accepted 2026-09-30

## Context

Each HTTP attempt must be recorded as an `Attempt` row with its own budget reservation (spec §7.3, §9.3). SDK-internal retries would be invisible to the ledger.

## Decision

Provider SDKs are constructed with `maxRetries: 0`. Retry, backoff, and `retry-after` handling live only in the engine's `retry.ts`.

## Consequences

Every attempt is visible and accounted for. The engine carries the retry logic the SDKs would otherwise provide.

## Revisit when

A provider requires SDK-managed retries for correctness.
