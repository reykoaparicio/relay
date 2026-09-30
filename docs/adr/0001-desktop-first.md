# ADR-0001: Desktop application first

**Status:** Accepted 2026-09-30

## Context

Relay's first outcome is reviewing a selected change, planning a fix, proposing a patch, and reviewing it (spec §1). That work needs direct access to a local project directory and a focused place to run and inspect the workflow.

## Decision

Build a local desktop application (Electron + React) rather than an editor extension or a web app.

## Consequences

Local project access is straightforward and user-selected. Desktop packaging, signing, and OS-specific behavior become our responsibility. Editor-native workflows are not served in P0.

## Revisit when

Users strongly prefer an editor extension.
