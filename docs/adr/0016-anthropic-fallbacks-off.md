# ADR-0016: Anthropic refusal fallback off by default

**Status:** Accepted 2026-09-30

## Context

The adapter must not silently switch models (spec §6.3, §8.4), and a fallback model has a different price (§9.2).

## Decision

Anthropic's refusal fallback (`fallbacks`) is off by default. It is opt-in per profile and recorded in the run snapshot.

## Consequences

Runs use exactly the model the user chose unless they opt in. Refusals pause the run instead of switching models.

## Revisit when

Users ask for automatic fallback and the ledger can price it honestly.
