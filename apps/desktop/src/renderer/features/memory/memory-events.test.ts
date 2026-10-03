import { describe, expect, it } from 'vitest';
import { MEMORY_EVENT_TYPES } from '@relay/contracts';
import { sid } from '../../api/fake-scenarios/world';
import { memoryEventActorText, memoryEventText } from './memory-events';
import type { MemoryEvent } from './memory-events';

const at = 1_700_000_000_000 as MemoryEvent['createdAt'];
const ev = (event: MemoryEvent['event'], detail?: Record<string, unknown> | null): MemoryEvent => ({
  event,
  revision: 1,
  actor: 'user',
  createdAt: at,
  ...(detail === undefined ? {} : { detail }),
});
const titleOf = (id: string) => (id === sid('memory', 2) ? 'Validate request bodies with zod' : undefined);

describe('memoryEventText (E2 #17)', () => {
  it('has plain text for every event type, without detail', () => {
    for (const t of MEMORY_EVENT_TYPES) {
      const text = memoryEventText(ev(t));
      expect(text).not.toBe('');
      expect(text).not.toContain('_');
    }
    expect(memoryEventText(ev('unarchived'))).toBe('Restored to approved');
    expect(memoryEventText(ev('history_purged'))).toBe('Earlier revisions purged (the current text was kept)');
  });

  it('reviewed: files checked and hashes refreshed', () => {
    expect(memoryEventText(ev('reviewed', { fileRefs: 1, refreshed: 1 }))).toBe('Confirmed still accurate · 1 source file checked, 1 hash refreshed');
    expect(memoryEventText(ev('reviewed', { fileRefs: 2, refreshed: 0 }))).toBe('Confirmed still accurate · 2 source files checked, no change found');
    expect(memoryEventText(ev('reviewed', { fileRefs: 0, refreshed: 0 }))).toBe('Confirmed still accurate');
  });

  it('skipped: the run and why it left the record out', () => {
    expect(memoryEventText(ev('skipped', { runId: sid('run', 22), status: 'archived' }))).toBe('Left out of Run 0022 because it was archived');
    expect(memoryEventText(ev('skipped', { runId: sid('run', 22), status: 'something_new' }))).toBe('Left out of Run 0022');
    expect(memoryEventText(ev('skipped', {}))).toBe('Left out of a run');
  });

  it('rejected, archived, conflict_resolved: reason, replacement, resolution', () => {
    expect(memoryEventText(ev('rejected', { reason: 'Too specific' }))).toBe('Rejected · reason: Too specific');
    expect(memoryEventText(ev('archived', { supersededById: sid('memory', 2) }), { titleOf })).toBe(
      'Archived · replaced by “Validate request bodies with zod”',
    );
    expect(memoryEventText(ev('archived', { supersededById: sid('memory', 99) }), { titleOf })).toBe('Archived · replaced by another record');
    expect(memoryEventText(ev('conflict_resolved', { resolution: 'rewrite', with: sid('memory', 2) }), { titleOf })).toBe(
      'Conflict resolved with “Validate request bodies with zod”: combined into a new record',
    );
    expect(memoryEventText(ev('conflict_resolved', { resolution: 'keepBothWithScopes' }))).toBe('Conflict resolved: both kept for different roles');
  });

  it('ignores unknown or mistyped detail keys (never dumps raw detail)', () => {
    expect(memoryEventText(ev('approved', { secret: 'x', nested: { a: 1 } }))).toBe('Approved');
    expect(memoryEventText(ev('rejected', { reason: 42 }))).toBe('Rejected');
    expect(memoryEventText(ev('reviewed', { fileRefs: 'one', refreshed: -1 }))).toBe('Confirmed still accurate');
    expect(memoryEventText(ev('edited', null))).toBe('Edited');
  });

  it('actor in words', () => {
    expect(memoryEventActorText('user')).toBe('by you');
    expect(memoryEventActorText(`run:${sid('run', 23)}`)).toBe('by Run 0023');
  });
});
