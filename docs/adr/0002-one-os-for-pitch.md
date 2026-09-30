# ADR-0002: One OS for the pitch

**Status:** Accepted 2026-09-30

## Context

The founder has roughly 140 planned hours before the pitch (spec header). Every additional OS multiplies packaging, credential-storage, and testing work.

## Decision

Target a single OS for P0: macOS on Apple silicon (arm64), confirmed 2026-09-30 (plans/00 §8).

## Consequences

Packaging, e2e, and demo verification run on macOS only. Windows and Linux users cannot try the prototype. OS-specific code is kept behind small host modules so a second OS is additive.

## Revisit when

A second-OS pilot user is ready.
