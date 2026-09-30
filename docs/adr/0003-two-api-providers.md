# ADR-0003: Two API providers

**Status:** Accepted 2026-09-30

## Context

The prototype must prove that two providers can contribute to one completed workflow (spec §1.3) without spending the schedule on connector sprawl.

## Decision

Support Anthropic and OpenAI through one common `ProviderAdapter` interface. Gemini is added as an optional third adapter after both pass (plans/04 §D10) and is the first scope cut if behind.

## Consequences

Portability is demonstrated with a small surface. Capability and price catalogs must be maintained per provider with sources and dates.

## Revisit when

A customer needs another provider.
