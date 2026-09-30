export interface Config {
  readonly port: number;
  /** Bearer token required on write endpoints. Empty disables auth (local dev only). */
  readonly apiToken: string;
  readonly requestTimeoutMs: number;
}

function readInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got "${raw}"`);
  }
  return value;
}

export function loadConfig(): Config {
  return {
    port: readInt('PORT', 3000),
    apiToken: process.env['SAMPLE_API_TOKEN'] ?? '',
    requestTimeoutMs: readInt('REQUEST_TIMEOUT_MS', 5000),
  };
}
