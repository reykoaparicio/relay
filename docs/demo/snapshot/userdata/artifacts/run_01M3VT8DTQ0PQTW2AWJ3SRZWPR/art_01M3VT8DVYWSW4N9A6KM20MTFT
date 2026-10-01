import { badRequest } from '../errors.js';

/** Narrow an unknown request body to a plain object or throw 400. */
export function requireObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw badRequest('Request body must be a JSON object');
  }
  return body as Record<string, unknown>;
}

export function requireString(value: unknown, field: string, maxLength = 200): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw badRequest(`${field} must be a non-empty string`);
  }
  if (value.length > maxLength) {
    throw badRequest(`${field} must be at most ${maxLength} characters`);
  }
  return value.trim();
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function requireEmail(value: unknown, field = 'email'): string {
  const email = requireString(value, field, 254);
  if (!EMAIL_PATTERN.test(email)) throw badRequest(`${field} must be a valid email address`);
  return email.toLowerCase();
}

/**
 * Accepts only whole numbers in [min, max]. Rejects negatives (by default),
 * fractions, NaN, Infinity, and numeric strings.
 */
export function requireNonNegativeInteger(value: unknown, field: string, max = Number.MAX_SAFE_INTEGER, min = 0): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw badRequest(`${field} must be an integer`);
  }
  if (value < min || value > max) {
    throw badRequest(`${field} must be between ${min} and ${max}`);
  }
  return value;
}

export function requirePositiveAmountCents(value: unknown, field = 'amountCents'): number {
  return requireNonNegativeInteger(value, field, 100_000_000, 1);
}
