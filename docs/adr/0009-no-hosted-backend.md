# ADR-0009: No hosted backend in P0

**Status:** Accepted 2026-09-30

## Context

A hosted backend adds cost, operations, and a data-custody story the prototype does not need (spec §6.2).

## Decision

Relay runs entirely locally. Project context leaves the machine only through configured provider calls.

## Consequences

No server cost or operations. No always-on or shared features. Local persistence does not make remote inference private or offline.

## Revisit when

Always-on or shared features are validated.
