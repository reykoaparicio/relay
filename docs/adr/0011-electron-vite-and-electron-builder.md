# ADR-0011: electron-vite + electron-builder instead of Electron Forge

**Status:** Accepted 2026-09-30

## Context

Spec §13.1 suggests `forge.config.ts`. As of 2026-09-30, Forge's Vite plugin is still experimental, while electron-vite supports utility-process entries (`?modulePath`) first-class, which the separate runner process needs (spec §6.1).

## Decision

Build with electron-vite 5 (Vite 7; its peer range stops at 7) for main, preload, renderer, and the runner chunk. Package with electron-builder 26. This deviates from spec §13.1.

## Consequences

The build config differs from the spec's Forge layout. Packaging, fuses, and ad-hoc signing are configured in `electron-builder.yml` (plans/08 §H9). Vite 8 cannot be adopted until electron-vite supports it.

## Revisit when

Forge's Vite plugin becomes stable, or electron-vite stops tracking Vite majors.
