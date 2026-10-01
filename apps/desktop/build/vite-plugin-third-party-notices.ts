// LIC-01: third-party license notices for Settings → About. Collects the node_modules packages that actually end up
// in the shipped bundles (main + its nested runner build, preload, renderer: every dependency is bundled, 08 H9),
// reads name / version / license / LICENSE text, groups packages with identical license text, and exposes the result
// to the renderer as `virtual:third-party-notices`.
//
// Design (why not a prebuild JSON): which packages are bundled is only known from the bundlers' module graphs, so a
// prebuild step would have to guess from package.json dependency trees (all of Relay's deps are devDependencies,
// mixed with test tooling). Instead ONE shared store is filled by `collect()` plugins in the main and preload builds
// (electron-vite builds main → preload → renderer sequentially in one process, and the runner's nested build reuses
// main's plugins), and the renderer's `provide()` plugin adds the renderer's own graph at generateBundle, when that
// graph is complete. The virtual module is emitted with a placeholder that is replaced in the final chunk (after
// minification), which avoids the chicken-and-egg of the renderer graph containing the module that lists it. If the
// renderer is built without main/preload (renderer-only config), the data is marked `partial`; in dev (serve) the
// module is a small stub — the list is a production-build artefact.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import type { Plugin } from 'vite';

/** The virtual module id the renderer imports. */
export const THIRD_PARTY_NOTICES_ID = 'virtual:third-party-notices';
const RESOLVED_ID = `\0${THIRD_PARTY_NOTICES_ID}`;
/** Replaced in the final renderer chunk by the JSON string of the notices. */
export const NOTICES_PLACEHOLDER = '__RELAY_THIRD_PARTY_NOTICES_JSON__';

/** One bundled package. */
export interface PackageNotice {
  readonly name: string;
  readonly version: string;
  /** SPDX expression from package.json (`UNKNOWN` when missing). */
  readonly license: string;
  /** LICENSE / LICENCE / COPYING text, normalized; a short statement when the package ships none. */
  readonly text: string;
}

/** Packages that share one identical license text. */
export interface NoticeGroup {
  /** The distinct SPDX ids of the group's packages, joined with " / ". */
  readonly license: string;
  readonly text: string;
  readonly packages: readonly { readonly name: string; readonly version: string }[];
}

/** The virtual module's default export. */
export interface ThirdPartyNotices {
  /** True when the list does not cover every build (dev server, renderer-only build). */
  readonly partial: boolean;
  readonly packageCount: number;
  readonly groups: readonly NoticeGroup[];
}

/**
 * The package root of a bundled module id, or null for ids outside node_modules (app sources, workspace packages,
 * virtual modules). Uses the LAST `node_modules` segment, so pnpm's `.pnpm/<pkg>@<v>/node_modules/<name>/…` layout and
 * nested node_modules both map to the package that owns the file. Scoped names keep their scope.
 */
export function packageRootOf(id: string, separator: string = sep): string | null {
  const clean = id.replace(/^\0/, '').replace(/[?#].*$/, '');
  const nm = `${separator}node_modules${separator}`;
  const at = clean.lastIndexOf(nm);
  if (at < 0) return null;
  const rest = clean.slice(at + nm.length).split(separator);
  const first = rest[0];
  if (first === undefined || first === '' || first.startsWith('.')) return null; // e.g. node_modules/.vite/…
  const nameParts = first.startsWith('@') ? rest.slice(0, 2) : [first];
  if (nameParts.length < (first.startsWith('@') ? 2 : 1) || nameParts.some((p) => p === '')) return null;
  return clean.slice(0, at + nm.length) + nameParts.join(separator);
}

const LICENSE_FILE_RE = /^(?:licen[cs]e|copying)(?:[-._][\w.-]*)?$/i;

/** Minimal fs surface (tests inject a fake). */
export interface NoticesFs {
  readFileSync(path: string, encoding: 'utf8'): string;
  readdirSync(path: string): string[];
  existsSync(path: string): boolean;
}

const realFs: NoticesFs = {
  readFileSync: (p, e) => readFileSync(p, e),
  readdirSync: (p) => readdirSync(p),
  existsSync: (p) => existsSync(p),
};

const normalizeText = (t: string): string => t.replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').trim();

/** Reads one package's notice from its root. Null when the root has no readable package.json. */
export function readPackageNotice(root: string, fs: NoticesFs = realFs): PackageNotice | null {
  let pkg: { name?: unknown; version?: unknown; license?: unknown; licenses?: unknown };
  try {
    pkg = JSON.parse(fs.readFileSync(join(root, 'package.json'), 'utf8')) as typeof pkg;
  } catch {
    return null;
  }
  if (typeof pkg.name !== 'string' || pkg.name === '') return null;
  const version = typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  let license = 'UNKNOWN';
  if (typeof pkg.license === 'string') license = pkg.license;
  else if (typeof pkg.license === 'object' && pkg.license !== null && typeof (pkg.license as { type?: unknown }).type === 'string') {
    license = (pkg.license as { type: string }).type;
  } else if (Array.isArray(pkg.licenses)) {
    license = (pkg.licenses as { type?: unknown }[]).map((l) => (typeof l.type === 'string' ? l.type : 'UNKNOWN')).join(' OR ');
  }
  let files: string[] = [];
  try {
    files = fs.readdirSync(root).filter((f) => LICENSE_FILE_RE.test(f)).sort();
  } catch {
    // no listing: fall through to the statement below
  }
  const texts: string[] = [];
  for (const f of files) {
    try {
      texts.push(normalizeText(fs.readFileSync(join(root, f), 'utf8')));
    } catch {
      // a directory named LICENSE, unreadable file: skip
    }
  }
  const text = texts.length > 0 ? texts.join('\n\n') : `Licensed under ${license}. The package does not include a license file.`;
  return { name: pkg.name, version, license, text };
}

/** Groups packages by identical license text; deterministic (packages and groups sorted by name). */
export function groupNotices(packages: readonly PackageNotice[], partial: boolean): ThirdPartyNotices {
  const unique = new Map<string, PackageNotice>();
  for (const p of packages) unique.set(`${p.name}@${p.version}`, p);
  const byText = new Map<string, { licenses: Set<string>; packages: { name: string; version: string }[] }>();
  for (const p of unique.values()) {
    const g = byText.get(p.text) ?? { licenses: new Set<string>(), packages: [] };
    g.licenses.add(p.license);
    g.packages.push({ name: p.name, version: p.version });
    byText.set(p.text, g);
  }
  const cmp = (a: { name: string; version: string }, b: { name: string; version: string }): number =>
    a.name === b.name ? a.version.localeCompare(b.version) : a.name.localeCompare(b.name);
  const groups: NoticeGroup[] = [...byText].map(([text, g]) => ({
    license: [...g.licenses].sort().join(' / '),
    text,
    packages: g.packages.sort(cmp),
  }));
  groups.sort((a, b) => cmp(a.packages[0] ?? { name: '', version: '' }, b.packages[0] ?? { name: '', version: '' }));
  return { partial, packageCount: unique.size, groups };
}

/** The part of a Rollup output bundle the collector reads. */
type BundleLike = Record<string, { type: 'chunk'; modules: Record<string, unknown> } | { type: 'asset'; originalFileNames?: readonly string[] }>;

/**
 * Package roots referenced by a bundle: every chunk module id and every asset's original files (fonts, images).
 * Vite records asset `originalFileNames` relative to the build root, so they are resolved against `root`.
 */
export function packageRootsOfBundle(bundle: BundleLike, root: string = process.cwd()): Set<string> {
  const roots = new Set<string>();
  const add = (id: string): void => {
    const r = packageRootOf(id);
    if (r !== null) roots.add(r);
  };
  for (const out of Object.values(bundle)) {
    if (out.type === 'chunk') for (const id of Object.keys(out.modules)) add(id);
    else for (const f of out.originalFileNames ?? []) add(resolve(root, f));
  }
  return roots;
}

/** Finds `<dir>/node_modules/<name>` walking up from `fromDir` (for packages inlined without a module id). */
export function findPackageRoot(name: string, fromDir: string, fs: NoticesFs = realFs): string | null {
  let dir = fromDir;
  for (;;) {
    const candidate = join(dir, 'node_modules', name);
    if (fs.existsSync(join(candidate, 'package.json'))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Options of {@link thirdPartyNotices}. */
export interface ThirdPartyNoticesOptions {
  /**
   * Packages whose code reaches the output without a module id of their own (e.g. Tailwind's preflight CSS, inlined
   * by the Tailwind compiler), resolved from `resolveFrom`.
   */
  readonly extraPackages?: readonly string[];
  readonly resolveFrom?: string;
  readonly fs?: NoticesFs;
}

/**
 * Creates the shared store. Use `collect('main')` / `collect('preload')` in those builds and `provide()` in the
 * renderer build.
 */
export function thirdPartyNotices(opts: ThirdPartyNoticesOptions = {}) {
  const fs = opts.fs ?? realFs;
  const roots = new Set<string>();
  const collected = new Set<string>();

  const collect = (label: string): Plugin => {
    let buildRoot = process.cwd();
    return {
      name: `relay:third-party-notices-collect:${label}`,
      apply: 'build',
      configResolved(config) {
        buildRoot = config.root;
      },
      generateBundle(_options, bundle) {
        for (const r of packageRootsOfBundle(bundle, buildRoot)) roots.add(r);
        collected.add(label);
      },
    };
  };

  const provide = (expect: readonly string[] = ['main', 'preload']): Plugin => {
    let serve = false;
    let buildRoot = process.cwd();
    return {
      name: 'relay:third-party-notices',
      configResolved(config) {
        serve = config.command === 'serve';
        buildRoot = config.root;
      },
      resolveId(id) {
        return id === THIRD_PARTY_NOTICES_ID ? RESOLVED_ID : null;
      },
      load(id) {
        if (id !== RESOLVED_ID) return null;
        if (serve) return `export default ${JSON.stringify({ partial: true, packageCount: 0, groups: [] } satisfies ThirdPartyNotices)};`;
        return `export default JSON.parse(${JSON.stringify(NOTICES_PLACEHOLDER)});`;
      },
      generateBundle: {
        order: 'post', // after minification (renderChunk): the placeholder is final
        handler(_options, bundle) {
          const target = Object.values(bundle).find((o) => o.type === 'chunk' && o.code.includes(NOTICES_PLACEHOLDER));
          if (target?.type !== 'chunk') return;
          const all = new Set([...roots, ...packageRootsOfBundle(bundle, buildRoot)]);
          for (const name of opts.extraPackages ?? []) {
            const r = findPackageRoot(name, opts.resolveFrom ?? process.cwd(), fs);
            if (r !== null) all.add(r);
          }
          const missing = expect.filter((l) => !collected.has(l));
          if (missing.length > 0) this.warn(`third-party notices: no data from the ${missing.join(', ')} build(s); the list is partial`);
          const notices = groupNotices(
            [...all].map((r) => readPackageNotice(r, fs)).filter((p): p is PackageNotice => p !== null),
            missing.length > 0,
          );
          // The placeholder sits inside a string literal (any quote style after minification): replace the whole
          // literal with a JSON-encoded string literal of the data.
          const literal = new RegExp(`(["'\`])${NOTICES_PLACEHOLDER}\\1`);
          target.code = target.code.replace(literal, () => JSON.stringify(JSON.stringify(notices)));
        },
      },
    };
  };

  return { collect, provide };
}
