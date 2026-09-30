# ADR-0007: Patches as artifacts

**Status:** Accepted 2026-09-30

## Context

The prototype must not modify the original project (spec §1.4, §3.3) and must not run arbitrary commands (§11.1).

## Decision

Proposed changes are produced as immutable patch artifacts that the user inspects and exports. Relay never applies them to source files.

## Consequences

No write path into user repositories exists in P0. Users apply patches themselves.

## Revisit when

Isolated execution is designed and verified.
