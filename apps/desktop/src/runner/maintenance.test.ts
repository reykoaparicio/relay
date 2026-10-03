import { describe, expect, it, vi } from 'vitest';
import { RelayError, appError, epochMs } from '@relay/contracts';
import { readMaintenanceTask, runMaintenanceTask } from './maintenance.js';

vi.mock('electron', () => ({}));

describe('runner maintenance mode', () => {
  it('reads RELAY_RUNNER_TASK; an unknown task throws instead of booting the engine', () => {
    expect(readMaintenanceTask({})).toBeUndefined();
    expect(readMaintenanceTask({ RELAY_RUNNER_TASK: 'restore_latest_backup' })).toBe('restore_latest_backup');
    expect(() => readMaintenanceTask({ RELAY_RUNNER_TASK: 'rm_everything' })).toThrow(/unknown RELAY_RUNNER_TASK/);
  });

  it('restore_latest_backup: maps the storage result to display paths', async () => {
    const restore = vi.fn(() => Promise.resolve({
      restoredFrom: '/Users/a/Library/Relay/backups/2026-10-01', backupCreatedAt: 42, backupKind: 'auto' as const,
      previousMovedTo: '/Users/a/Library/Relay/relay.sqlite.before-restore-1', restoredArtifacts: 0,
    }));

    const r = await runMaintenanceTask('restore_latest_backup', { userDataDir: '/Users/a/Library/Relay', homeDir: '/Users/a', restore, clock: { now: () => epochMs(1) } });

    expect(restore).toHaveBeenCalledWith(expect.objectContaining({ userDataDir: '/Users/a/Library/Relay' }));
    expect(r).toEqual({
      ok: true, restored: true, restoredFromDisplayPath: '~/Library/Relay/backups/2026-10-01', backupCreatedAt: 42,
      previousMovedToDisplayPath: '~/Library/Relay/relay.sqlite.before-restore-1',
    });
  });

  it('no usable backup → restored: false; a thrown error → ok: false with its code (never throws)', async () => {
    const none = await runMaintenanceTask('restore_latest_backup', { userDataDir: '/ud', homeDir: '/h', restore: () => Promise.resolve(null) });
    const relay = await runMaintenanceTask('restore_latest_backup', {
      userDataDir: '/ud', homeDir: '/h', restore: () => Promise.reject(new RelayError(appError('CONFLICT'))),
    });
    const other = await runMaintenanceTask('restore_latest_backup', { userDataDir: '/ud', homeDir: '/h', restore: () => Promise.reject(new Error('EIO')) });

    expect(none).toEqual({ ok: true, restored: false, restoredFromDisplayPath: null, backupCreatedAt: null, previousMovedToDisplayPath: null });
    expect(!relay.ok && relay.error.code).toBe('CONFLICT');
    expect(!other.ok && other.error.code).toBe('ARTIFACT_WRITE_FAILED');
  });
});
