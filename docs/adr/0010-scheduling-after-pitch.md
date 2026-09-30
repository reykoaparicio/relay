# ADR-0010: Scheduling after the pitch

**Status:** Accepted 2026-09-30

## Context

Schedules are part of the vision and data design, but core workflow reliability matters more for the pitch (spec §3.1, §14).

## Decision

Do not build schedules in P0.

## Consequences

The critical path stays focused on one reliable run. Routine recurrence waits for P1.

## Revisit when

Users demonstrate scheduled recurrence.
