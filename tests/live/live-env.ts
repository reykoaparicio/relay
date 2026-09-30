// Shared gating for the live provider tests (04 §D9 / §D9b). They spend real money, so they run ONLY with
// RELAY_LIVE_TESTS=1 and read keys from the test runner's environment (never the app's credential store).
import { readFileSync } from 'node:fs';
import type { ProviderId } from '@relay/contracts';

/** True only when the operator explicitly opted in. */
export const LIVE = process.env['RELAY_LIVE_TESTS'] === '1';

const KEY_ENV: Partial<Record<ProviderId, string>> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
};

/** The provider key from the test env, or `undefined` (the test is then skipped with a printed notice). */
export function liveKey(providerId: ProviderId): string | undefined {
  const name = KEY_ENV[providerId];
  const value = name === undefined ? undefined : process.env[name]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

/** Integer µUSD cap from env, else the default. Invalid values fail loudly rather than lifting the cap. */
export function capFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer µUSD amount`);
  return n;
}

/** Prints why a live suite is skipped (visible in the vitest output). */
export function skipNotice(providerId: ProviderId): void {
  if (!LIVE) return;
  if (liveKey(providerId) === undefined) {
    process.stdout.write(`[live] skipping ${providerId}: ${KEY_ENV[providerId] ?? 'key'} is not set in the test env\n`);
  }
}

/** A 20-line excerpt of the sample project, used as the tiny generate input. */
export function sampleInput20Lines(): string {
  const text = readFileSync(new URL('../fixtures/sample-api/src/handlers/user.ts', import.meta.url), 'utf8');
  return text.split('\n').slice(0, 20).join('\n');
}

/** Formats µUSD as dollars for the printed totals. */
export function usd(microusd: number): string {
  return `$${(microusd / 1_000_000).toFixed(6)}`;
}
