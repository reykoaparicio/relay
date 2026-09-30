# ADR-0018: Versioned, resource-namespaced IPC with a Result envelope

**Status:** Accepted 2026-09-30

## Context

Relay has no HTTP server (ADR-0009). Its API is the IPC surface between renderer, main, and runner (plans/02).

## Decision

IPC channels are named `relay/v1/<resource>.<verb>`, validated with Zod at every hop, and return an `IpcResult` envelope (`{ ok: true, data } | { ok: false, error }`).

## Consequences

The surface is explicit, versioned, and testable. Breaking changes require a new version namespace.

## Revisit when

A second client (headless runner, extension) needs a different transport.
