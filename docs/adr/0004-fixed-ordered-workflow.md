# ADR-0004: Fixed ordered workflow

**Status:** Accepted 2026-09-30

## Context

A general workflow framework is explicitly out of scope (spec §6.1). The value to demonstrate is one reliable, inspectable workflow.

## Decision

Ship one fixed, ordered review-propose-fix template with a deterministic run/step state machine. Arbitrary workflow structure is disabled.

## Consequences

State, recovery, and UI stay simple and testable. Users cannot compose their own graphs in P0.

## Revisit when

Multiple validated workflows need branching.
