import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { ExclusionReason } from '@relay/contracts';
import { EXCLUSION_REASONS, INPUT_CAPS } from '@relay/contracts';
import type { ClassifyContext, EntryStat, Sniff } from './exclusions.js';
import { SNIFF_BYTES, classify, compileUserPatterns, sniffBytes } from './exclusions.js';
import { makeGitignoreMatcher, parseGitignore } from './gitignore.js';

const FILE: EntryStat = { isDirectory: false, size: 10 };
const DIR: EntryStat = { isDirectory: true, size: 0 };
const TEXT: Sniff = { hasNul: false, nonTextRatio: 0 };
const BASE: ClassifyContext = { maxFileBytes: INPUT_CAPS.maxFileBytes };

function reasonOf(relPath: string, stat: EntryStat = FILE, sniff: Sniff | null = TEXT, ctx: ClassifyContext = BASE) {
  const c = classify(relPath, stat, sniff, ctx);
  return c.included ? 'included' : c.reason;
}

describe('classify: one row per reason code', () => {
  const rows: readonly [ExclusionReason, () => string][] = [
    ['dependency_dir', () => reasonOf('node_modules/lodash/index.js')],
    ['build_output', () => reasonOf('dist/app.js')],
    ['vcs_internal', () => reasonOf('.git/config')],
    ['secret', () => reasonOf('.env')],
    ['os_file', () => reasonOf('.DS_Store')],
    ['binary', () => reasonOf('src/data.bin', FILE, { hasNul: true, nonTextRatio: 0.01 })],
    ['too_large', () => reasonOf('src/big.ts', { isDirectory: false, size: INPUT_CAPS.maxFileBytes + 1 })],
    [
      'gitignored',
      () => reasonOf('generated/a.ts', FILE, TEXT, { ...BASE, isGitignored: makeGitignoreMatcher(new Map([['', parseGitignore('generated/\n')]])) }),
    ],
    ['user_pattern', () => reasonOf('fixtures/x.json', FILE, TEXT, { ...BASE, isUserExcluded: compileUserPatterns(['fixtures/**']) })],
    ['cap_exceeded', () => reasonOf('src/a.ts', FILE, TEXT, { ...BASE, caps: { maxFiles: 1, maxTotalBytes: 100, includedFiles: 1, includedBytes: 5 } })],
  ];

  it.each(rows)('%s', (expected, run) => {
    expect(run()).toBe(expected);
  });

  it('covers every contracts EXCLUSION_REASON (symlink_outside comes from E1 via scan)', () => {
    const covered = new Set<string>([...rows.map(([r]) => r), 'symlink_outside']);

    expect([...EXCLUSION_REASONS].every((r) => covered.has(r))).toBe(true);
  });

  it.each([
    ['vendor/x.php', 'dependency_dir'],
    ['.venv/lib/x.py', 'dependency_dir'],
    ['pkg/__pycache__/x.pyc', 'dependency_dir'],
    ['target/debug/x', 'dependency_dir'],
    ['public/app.min.js', 'build_output'],
    ['src/a.js.map', 'build_output'],
    ['out/x.bundle.js', 'build_output'],
    ['.next/x.js', 'build_output'],
    ['.hg/store', 'vcs_internal'],
    ['.svn/entries', 'vcs_internal'],
    ['config/.env.local', 'secret'],
    ['certs/server.pem', 'secret'],
    ['k/app.key', 'secret'],
    ['k/cert.p12', 'secret'],
    ['k/cert.pfx', 'secret'],
    ['id_rsa.pub', 'secret'],
    ['id_ed25519', 'secret'],
    ['.npmrc', 'secret'],
    ['.pypirc', 'secret'],
    ['.netrc', 'secret'],
    ['.aws/config', 'secret'],
    ['.ssh/known_hosts', 'secret'],
    ['.gnupg/pubring', 'secret'],
    ['credentials.json', 'secret'],
    ['android/release.keystore', 'secret'],
    ['service-account-prod.json', 'secret'],
    // Security audit S1: common credential files that previously reached model context.
    ['.envrc', 'secret'],
    ['prod.env', 'secret'],
    ['.env-prod', 'secret'],
    ['.env_local', 'secret'],
    ['deploy/id_ecdsa', 'secret'],
    ['deploy/id_dsa', 'secret'],
    ['.git-credentials', 'secret'],
    ['.dev.vars', 'secret'],
    ['.pgpass', 'secret'],
    ['.yarnrc.yml', 'secret'],
    ['infra/prod.tfvars', 'secret'],
    ['android/upload.jks', 'secret'],
    ['.docker/config.json', 'secret'],
    ['.kube/config', 'secret'],
    ['home/.config/gcloud/configurations/config_default', 'secret'],
    ['Library/Keychains/login.keychain-db', 'secret'],
    ['.config/app.json', 'included'],
    ['src/environment.ts', 'included'],
    ['Thumbs.db', 'os_file'],
    ['desktop.ini', 'os_file'],
    ['src/._a.ts', 'os_file'],
    ['assets/logo.PNG', 'binary'],
    ['lib/x.wasm', 'binary'],
    ['src/index.ts', 'included'],
    ['README.md', 'included'],
  ])('%s → %s', (p, expected) => {
    expect(reasonOf(p)).toBe(expected);
  });

  it('classifies excluded directories by name (so scan can prune them)', () => {
    expect(reasonOf('node_modules', DIR, null)).toBe('dependency_dir');
    expect(reasonOf('src/build', DIR, null)).toBe('build_output');
    expect(reasonOf('src', DIR, null)).toBe('included');
  });
});

describe('classify: precedence', () => {
  it('node_modules/.env reports secret (secret is checked first)', () => {
    expect(reasonOf('node_modules/.env')).toBe('secret');
  });

  it('dist/.git/x reports vcs_internal before build_output', () => {
    expect(reasonOf('dist/.git/x')).toBe('vcs_internal');
  });

  it('a gitignored binary reports gitignored; a too-large binary reports binary', () => {
    const ctx = { ...BASE, isGitignored: () => true };

    expect(reasonOf('a.png', FILE, TEXT, ctx)).toBe('gitignored');
    expect(reasonOf('a.bin', { isDirectory: false, size: 10 ** 9 }, { hasNul: true, nonTextRatio: 1 })).toBe('binary');
  });

  it('too_large wins over cap_exceeded', () => {
    const ctx = { ...BASE, caps: { maxFiles: 0, maxTotalBytes: 0, includedFiles: 0, includedBytes: 0 } };

    expect(reasonOf('a.ts', { isDirectory: false, size: INPUT_CAPS.maxFileBytes + 1 }, TEXT, ctx)).toBe('too_large');
  });

  it('cap_exceeded triggers on the byte total too', () => {
    const ctx = { ...BASE, caps: { maxFiles: 10, maxTotalBytes: 15, includedFiles: 1, includedBytes: 10 } };

    expect(reasonOf('a.ts', FILE, TEXT, ctx)).toBe('cap_exceeded');
  });

  it('classify is deterministic and never throws on arbitrary names (property)', () => {
    fc.assert(
      fc.property(fc.array(fc.string({ minLength: 1, maxLength: 10 }), { minLength: 1, maxLength: 5 }), fc.boolean(), (segs, isDir) => {
        const p = segs.join('/');
        const stat = { isDirectory: isDir, size: 1 };
        expect(classify(p, stat, TEXT, BASE)).toEqual(classify(p, stat, TEXT, BASE));
      }),
    );
  });
});

describe('secrets', () => {
  it('includes .env.example', () => {
    expect(reasonOf('.env.example')).toBe('included');
    expect(reasonOf('config/.ENV.EXAMPLE')).toBe('included');
  });

  it('matches *secret* case-insensitively', () => {
    expect(reasonOf('src/MySecretStore.ts')).toBe('secret');
    expect(reasonOf('SECRETS.md')).toBe('secret');
    expect(reasonOf('config/.ENV')).toBe('secret');
  });
});

describe('user patterns and gitignore', () => {
  it('a user pattern on a directory excludes files beneath it', () => {
    const ctx = { ...BASE, isUserExcluded: compileUserPatterns(['generated']) };

    expect(reasonOf('generated/deep/a.ts', FILE, TEXT, ctx)).toBe('user_pattern');
    expect(reasonOf('src/a.ts', FILE, TEXT, ctx)).toBe('included');
  });

  it('user patterns use dot: true', () => {
    const ctx = { ...BASE, isUserExcluded: compileUserPatterns(['**/*.snap']) };

    expect(reasonOf('.hidden/a.snap', FILE, TEXT, ctx)).toBe('user_pattern');
  });

  it('nested .gitignore negation re-includes a file', () => {
    const rules = new Map([
      ['', parseGitignore('*.log\n')],
      ['keep', parseGitignore('!important.log\n')],
    ]);
    const ctx = { ...BASE, isGitignored: makeGitignoreMatcher(rules) };

    expect(reasonOf('a.log', FILE, TEXT, ctx)).toBe('gitignored');
    expect(reasonOf('keep/important.log', FILE, TEXT, ctx)).toBe('included');
    expect(reasonOf('keep/other.log', FILE, TEXT, ctx)).toBe('gitignored');
    expect(reasonOf('other/x.ts', FILE, TEXT, ctx)).toBe('included');
  });
});

describe('sniffBytes', () => {
  it('detects a NUL byte', () => {
    const s = sniffBytes(new Uint8Array([104, 105, 0, 33]));

    expect(s.hasNul).toBe(true);
    expect(reasonOf('x.dat', FILE, s)).toBe('binary');
  });

  it('flags > 30% non-text bytes as binary and plain text as text', () => {
    const noisy = sniffBytes(new Uint8Array([1, 2, 3, 4, 65, 66]));
    const text = sniffBytes(new TextEncoder().encode('const x = 1;\n\tréé\r\n'));

    expect(noisy.nonTextRatio).toBeGreaterThan(0.3);
    expect(reasonOf('x.dat', FILE, noisy)).toBe('binary');
    expect(text).toEqual({ hasNul: false, nonTextRatio: 0 });
  });

  it('looks only at the first 8 KiB and handles empty input', () => {
    const bytes = new Uint8Array(SNIFF_BYTES + 10).fill(65);
    bytes[SNIFF_BYTES + 5] = 0;

    expect(sniffBytes(bytes).hasNul).toBe(false);
    expect(sniffBytes(new Uint8Array())).toEqual({ hasNul: false, nonTextRatio: 0 });
  });
});
