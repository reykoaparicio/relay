# ADR-0015: Diff input without a git subprocess

**Status:** Accepted 2026-09-30

## Context

"Run arbitrary shell commands" is denied in P0 (spec §11.1).

## Decision

Diff input is either a set of selected files or an imported `.diff`/`.patch` file. No `git` subprocess runs in P0. isomorphic-git is a P1 option.

## Consequences

No shell execution exists. Users export a diff themselves when they want to review a change.

## Revisit when

A pure-JS git integration is validated for P1.
