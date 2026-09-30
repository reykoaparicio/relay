# ADR-0005: SQLite local persistence

**Status:** Accepted 2026-09-30

## Context

State is small, single-user, and must survive crashes and restarts (spec §6.4, FR-07).

## Decision

Store structured state in a local SQLite database, with ordinary files for large artifacts. The runner is the sole writer. Implementation details are in ADR-0012.

## Consequences

Durable, transactional local state with no server. Remote collaboration is not possible without a new storage design.

## Revisit when

Remote collaboration becomes real demand.
