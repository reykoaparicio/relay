# ADR-0014: No model tool use in P0

**Status:** Accepted 2026-09-30

## Context

Model-directed tool calls widen the permission surface (spec §11.1, §11.4).

## Decision

The application assembles context up front through typed reads. Models do not call tools in P0. The tool-call limit stays enforced for the future.

## Consequences

The permission surface is only the typed application reads. Models cannot fetch additional context mid-run.

## Revisit when

A workflow needs model-driven retrieval and the permission model is designed for it.
