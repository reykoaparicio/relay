# ADR-0012: `node:sqlite` behind a `SqlDriver` interface

**Status:** Accepted 2026-09-30

## Context

Native SQLite modules need ABI rebuilds for Electron and ASAR unpacking, and they behave differently in Vitest and Electron.

## Decision

Use Node's built-in `node:sqlite` `DatabaseSync` (Node 24, Stability 1.2 RC) behind a small `SqlDriver` interface in `@relay/storage`. `better-sqlite3` v13 (N-API) is the fallback behind the same interface.

## Consequences

No native rebuild, the same code runs in tests and the app, and `backup()` is built in. We depend on a release-candidate Node API; the interface keeps the fallback cheap.

## Revisit when

`node:sqlite` shows a correctness or performance problem, or its API changes incompatibly.
