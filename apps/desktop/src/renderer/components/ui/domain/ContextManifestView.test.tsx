import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { ContextManifest } from '@relay/contracts';
import { fakeId, fakeSha, manifest } from '../test-fixtures';
import { ContextManifestView } from './ContextManifestView';

function rowsOf(caption: string): string[][] {
  const table = screen.getByRole('table', { name: caption });
  return within(table)
    .getAllByRole('row')
    .slice(1)
    .map((r) => [...r.querySelectorAll('th, td')].map((c) => c.textContent));
}

/** The value next to a KeyValueList term. */
function valueOf(term: string): string {
  const value = screen.getByText(term).nextElementSibling;
  if (value === null) throw new Error(`no value next to ${term}`);
  return value.textContent;
}

describe('ContextManifestView (§5.4 Context used)', () => {
  it('summarizes the request: profile + provider, model, catalog, token use and basis, receiving providers', () => {
    render(<ContextManifestView manifest={manifest()} />);

    expect(valueOf('Profile')).toBe('Balanced · Anthropic');
    expect(valueOf('Model')).toBe('claude-opus-5-5');
    expect(valueOf('Price catalog')).toBe('2026-09-30');
    expect(valueOf('Input tokens')).toBe('12.4k of 150k (local estimate)');
    expect(valueOf('Providers receiving this context')).toBe('Anthropic');
  });

  it('lists every file with included/omitted status and why, and memory with its flags', () => {
    render(<ContextManifestView manifest={manifest()} />);

    const files = rowsOf('Files in this context');
    expect(files.map((r) => r.slice(0, 3))).toEqual([
      ['src/routes/users.ts', 'Included', 'Selected by you'],
      ['src/big.ts', 'Omitted', 'Selected by you'],
    ]);
    expect(rowsOf('Memory in this context')).toEqual([[fakeId('mem', 1), 'User rule', '3', 'Included, pinned']]);
  });

  it('explains what was left out and why; no upstream table when nothing came from earlier steps', () => {
    render(<ContextManifestView manifest={manifest()} />);

    const leftOut = screen.getByRole('heading', { name: 'Left out' }).parentElement as HTMLElement;
    expect(within(leftOut).getByRole('listitem')).toHaveTextContent('src/big.ts (file): Over the token budget');
    expect(screen.queryByRole('table', { name: 'Upstream artifacts' })).not.toBeInTheDocument();
  });

  it('shows upstream artifacts, provider-count basis, "none" receivers, stale memory, and empty states', () => {
    const m: ContextManifest = {
      ...manifest(),
      files: [],
      memory: [{ recordId: fakeId('mem', 2) as never, revision: 1, type: 'project_decision', included: false, pinned: false, stale: true, score: 0 }],
      upstream: [{ stepKey: 'review' as never, artifactId: fakeId('art', 1) as never, schemaId: 'findings.v1', sha256: fakeSha('f00d') }],
      omitted: [],
      tokens: { estimatedInput: 10, budget: 100, basis: 'provider_count' },
      providersReceivingContext: [],
    };

    render(<ContextManifestView manifest={m} />);

    expect(valueOf('Input tokens')).toContain('(provider count)');
    expect(valueOf('Providers receiving this context')).toBe('none');
    expect(screen.getByText('No project files in this context.')).toBeInTheDocument();
    expect(rowsOf('Memory in this context')[0]?.[3]).toBe('Omitted, stale source');
    expect(rowsOf('Upstream artifacts')[0]?.slice(0, 2)).toEqual(['Review', 'findings.v1']);
    expect(screen.queryByRole('heading', { name: 'Left out' })).not.toBeInTheDocument();
  });
});
