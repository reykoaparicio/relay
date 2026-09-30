import { describe, expect, it } from 'vitest';
import { readRepoFileText } from './read-file.testing';

const tokensCss = readRepoFileText('apps/desktop/src/renderer/styles/tokens.css');

type Palette = Readonly<Record<string, string>>;

function extractBlock(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`selector not found: ${selector}`);
  const end = css.indexOf('}', start);
  return css.slice(start, end);
}

function parseColors(block: string): Record<string, string> {
  const colors: Record<string, string> = {};
  for (const m of block.matchAll(/--(color-[a-z-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) {
    const [, name, hex] = m;
    if (name !== undefined && hex !== undefined) colors[name] = hex;
  }
  return colors;
}

const dark: Palette = parseColors(extractBlock(tokensCss, ':root'));
const light: Palette = { ...dark, ...parseColors(extractBlock(tokensCss, ':root[data-theme="light"]')) };

function channel(hex: string, offset: number): number {
  const c = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  return 0.2126 * channel(hex, 1) + 0.7152 * channel(hex, 3) + 0.0722 * channel(hex, 5);
}

/** WCAG 2.x contrast ratio. */
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

// Declared text/background pairs (09 contrast.test.ts). Every pair must reach WCAG AA 4.5:1.
const PAIRS: ReadonlyArray<readonly [fg: string, bg: string]> = [
  ['color-text', 'color-canvas'],
  ['color-text', 'color-surface'],
  ['color-text', 'color-surface-raised'],
  ['color-text', 'color-surface-selected'],
  ['color-text', 'color-sidebar'],
  ['color-text-muted', 'color-surface'],
  ['color-text-muted', 'color-canvas'],
  ['color-text-muted', 'color-surface-raised'],
  ['color-text-muted', 'color-sidebar'],
  ['color-text-subtle', 'color-surface'],
  ['color-success', 'color-success-bg'],
  ['color-warning', 'color-warning-bg'],
  ['color-danger', 'color-danger-bg'],
  ['color-info', 'color-info-bg'],
  ['color-unknown', 'color-unknown-bg'],
  ['color-neutral', 'color-neutral-bg'],
  ['color-accent', 'color-accent-bg'],
  ['color-accent', 'color-accent-bg-hover'],
  ['color-accent', 'color-surface'],
  ['color-accent', 'color-canvas'],
];

describe.each([
  ['dark', dark],
  ['light', light],
] as const)('%s theme contrast', (_name, palette) => {
  it('defines every color used by the declared pairs', () => {
    const missing = PAIRS.flat().filter((token) => palette[token] === undefined);

    expect(missing).toEqual([]);
  });

  it.each(PAIRS)('%s on %s is at least 4.5:1', (fg, bg) => {
    const ratio = contrast(palette[fg] ?? '#000000', palette[bg] ?? '#000000');

    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });
});
