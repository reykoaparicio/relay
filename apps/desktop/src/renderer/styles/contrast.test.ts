/**
 * Theme contrast guarantee (09 contrast.test.ts, 00b §5 "4.5:1 contrast").
 *
 * This file, not axe, is what proves text contrast in BOTH themes: jsdom computes no colors, so the
 * axe runs in components/ui/a11y.test.tsx disable `color-contrast` and only check structure (roles,
 * names, labels). Here every text/background pair the components actually render is resolved from
 * tokens.css and components.css (including `color-mix` tints blended over their real background) and
 * must reach WCAG AA 4.5:1 in the dark and the light palette.
 */
import { describe, expect, it } from 'vitest';
import { readRepoFileText } from './read-file.testing';

const tokensCss = readRepoFileText('apps/desktop/src/renderer/styles/tokens.css');
const componentsCss = readRepoFileText('apps/desktop/src/renderer/styles/components.css');

type Palette = Readonly<Record<string, string>>;
type Rgb = readonly [number, number, number];

const WCAG_AA = 4.5;

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

/** Selector → declarations for every innermost rule in components.css (comma lists split). */
function parseRules(css: string): ReadonlyMap<string, string> {
  const rules = new Map<string, string>();
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const [, selectors, body] = m;
    if (selectors === undefined || body === undefined) continue;
    for (const selector of selectors.split(',')) rules.set(selector.trim().replace(/\s+/g, ' '), body);
  }
  return rules;
}

const rules = parseRules(componentsCss);

function declaration(selector: string, property: 'color' | 'background'): string {
  const body = rules.get(selector);
  if (body === undefined) throw new Error(`components.css has no rule for: ${selector}`);
  const m = new RegExp(`(?:^|;|\\s)${property}:\\s*([^;]+);`).exec(body);
  if (m?.[1] === undefined) throw new Error(`${selector} sets no ${property}`);
  return m[1].trim();
}

function hexToRgb(hex: string): Rgb {
  return [1, 3, 5].map((o) => Number.parseInt(hex.slice(o, o + 2), 16)) as unknown as Rgb;
}

function rgbToHex(rgb: Rgb): string {
  return `#${rgb.map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')}`;
}

function tokenHex(palette: Palette, token: string): string {
  const hex = palette[token];
  if (hex === undefined) throw new Error(`token not defined: ${token}`);
  return hex;
}

/**
 * Resolves a CSS color value to an opaque hex. `var(--color-x)` reads the palette;
 * `color-mix(in srgb, var(--color-x) N%, transparent)` is X at N% alpha, composited over `base`.
 */
function resolveColor(value: string, palette: Palette, base: string): string {
  const plain = /^var\(--(color-[a-z-]+)\)$/.exec(value);
  if (plain?.[1] !== undefined) return tokenHex(palette, plain[1]);
  const mix = /^color-mix\(in srgb, var\(--(color-[a-z-]+)\) (\d+)%, transparent\)$/.exec(value);
  if (mix?.[1] !== undefined && mix[2] !== undefined) {
    const alpha = Number(mix[2]) / 100;
    const fg = hexToRgb(tokenHex(palette, mix[1]));
    const bg = hexToRgb(base);
    return rgbToHex([0, 1, 2].map((i) => (fg[i] ?? 0) * alpha + (bg[i] ?? 0) * (1 - alpha)) as unknown as Rgb);
  }
  throw new Error(`unsupported color value: ${value}`);
}

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

// Token-level text/background pairs used by the components. Every pair must reach WCAG AA 4.5:1.
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
  ['color-text-muted', 'color-surface-selected'],
  ['color-text-subtle', 'color-surface'],
  ['color-text-subtle', 'color-surface-raised'],
  ['color-text-subtle', 'color-canvas'],
  ['color-text-subtle', 'color-sidebar'],
  ['color-success', 'color-success-bg'],
  ['color-warning', 'color-warning-bg'],
  ['color-danger', 'color-danger-bg'],
  ['color-danger', 'color-surface'],
  ['color-danger', 'color-surface-raised'],
  ['color-info', 'color-info-bg'],
  ['color-info', 'color-canvas'],
  ['color-unknown', 'color-unknown-bg'],
  ['color-neutral', 'color-neutral-bg'],
  ['color-accent', 'color-accent-bg'],
  ['color-accent', 'color-accent-bg-hover'],
  ['color-accent', 'color-surface'],
  ['color-accent', 'color-canvas'],
];

/**
 * Pairs read from the actual rules in components.css: the foreground is that rule's `color`, the
 * background is a token or (for `rule-tint`) that rule's own `background` tint over a base token.
 */
type CssBackground = { readonly token: string } | { readonly ruleTintOver: string };
const CSS_PAIRS: ReadonlyArray<readonly [name: string, selector: string, bg: CssBackground]> = [
  ['selected choice description', '.choice:has(input:checked) .subtle', { token: 'color-surface-selected' }],
  ['selected list item caption', '.list-item[aria-current="true"] .subtle', { token: 'color-surface-selected' }],
  ['diff added line on its tint', '.diff-add', { ruleTintOver: 'color-canvas' }],
  ['diff removed line on its tint', '.diff-del', { ruleTintOver: 'color-canvas' }],
  ['diff hunk header', '.diff-hunk', { token: 'color-canvas' }],
  ['diff file meta line', '.subtle', { token: 'color-canvas' }],
  ['field hint', '.field .hint', { token: 'color-surface' }],
  ['field error', '.field .error', { token: 'color-surface' }],
  ['ledger caption', '.ledger caption', { token: 'color-surface' }],
  ['table column header', '.table thead th', { token: 'color-surface' }],
  ['sidebar eyebrow', '.eyebrow', { token: 'color-sidebar' }],
  ['excluded file', '.tree li.excluded', { token: 'color-surface' }],
  ['recovery status detail', '.status-detail', { token: 'color-surface' }],
  ['stat tile label aside', '.stat .label-aside', { token: 'color-surface' }],
  ['provider status in the page header', '.provider-status', { token: 'color-canvas' }],
  ['provider status in a card', '.provider-status', { token: 'color-surface' }],
  ['provider status warning in the page header', '.provider-status.warn', { token: 'color-canvas' }],
  ['provider status warning in a card', '.provider-status.warn', { token: 'color-surface' }],
  ['safe note in a card', '.safe-note', { token: 'color-surface' }],
  ['safe note on the canvas', '.safe-note', { token: 'color-canvas' }],
  ['cost legend on the canvas', '.cost-legend', { token: 'color-canvas' }],
  ['cost legend in a card', '.cost-legend', { token: 'color-surface' }],
  ['reported certainty tag in a table', '.tag.certainty-reported', { token: 'color-surface' }],
  ['reported certainty tag on a raised row', '.tag.certainty-reported', { token: 'color-surface-raised' }],
  ['estimated certainty tag in a table', '.tag.certainty-estimated', { token: 'color-surface' }],
  ['estimated certainty tag on a raised row', '.tag.certainty-estimated', { token: 'color-surface-raised' }],
  ['unknown certainty tag on its tint', '.tag.certainty-unknown', { ruleTintOver: 'color-surface' }],
];

function cssPairColors(palette: Palette, selector: string, bg: CssBackground): readonly [string, string] {
  const background = 'token' in bg
    ? tokenHex(palette, bg.token)
    : resolveColor(declaration(selector, 'background'), palette, tokenHex(palette, bg.ruleTintOver));
  const foreground = resolveColor(declaration(selector, 'color'), palette, background);
  return [foreground, background];
}

describe.each([
  ['dark', dark],
  ['light', light],
] as const)('%s theme contrast', (_name, palette) => {
  it('defines every color used by the declared pairs', () => {
    const missing = PAIRS.flat().filter((token) => palette[token] === undefined);

    expect(missing).toEqual([]);
  });

  it.each(PAIRS)('%s on %s is at least 4.5:1', (fg, bg) => {
    const ratio = contrast(tokenHex(palette, fg), tokenHex(palette, bg));

    expect(ratio).toBeGreaterThanOrEqual(WCAG_AA);
  });

  it.each(CSS_PAIRS)('%s (%s) is at least 4.5:1', (_label, selector, bg) => {
    const [fg, background] = cssPairColors(palette, selector, bg);

    expect(contrast(fg, background)).toBeGreaterThanOrEqual(WCAG_AA);
  });
});

describe('contrast helpers', () => {
  it('blends a color-mix tint over its base like the browser does', () => {
    const blended = resolveColor('color-mix(in srgb, var(--color-x) 10%, transparent)', { 'color-x': '#FFFFFF' }, '#000000');

    expect(blended).toBe('#1a1a1a');
  });
});
