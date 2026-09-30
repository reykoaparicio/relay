# ADR-0006: Human-approved memory

**Status:** Accepted 2026-09-30

## Context

Persistent instructions that silently accumulate from model output are hard to inspect and can carry prompt injection forward (spec §10).

## Decision

Project memory records become active only after explicit human approval, with revisions and provenance kept.

## Consequences

Memory stays inspectable and scoped. Users spend some effort approving records.

## Revisit when

Approval burden becomes measured friction.
