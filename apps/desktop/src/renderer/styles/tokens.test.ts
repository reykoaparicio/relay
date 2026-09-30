import { describe, expect, it } from 'vitest';
import { readRepoFileBytes } from './read-file.testing';

const APP_TOKENS = 'apps/desktop/src/renderer/styles/tokens.css';
const MOCK_TOKENS = 'plans/mocks/assets/tokens.css';

describe('design tokens', () => {
  it('styles/tokens.css is byte-identical to plans/mocks/assets/tokens.css (single source of truth)', () => {
    const app = readRepoFileBytes(APP_TOKENS);
    const mock = readRepoFileBytes(MOCK_TOKENS);

    expect(mock.byteLength).toBeGreaterThan(1000);
    expect(app.byteLength).toBe(mock.byteLength);
    expect(app.findIndex((byte, i) => byte !== mock[i])).toBe(-1);
  });
});
