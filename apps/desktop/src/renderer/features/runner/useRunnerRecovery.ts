// Runner recovery (E2 #3/#4): restart the background runner, quit and relaunch Relay, or restore the latest backup.
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { call } from '../../api/client';
import { qk } from '../../api/keys';
import { useToast } from '../../components/ui';
import { formatDate } from '../../lib/format';

/**
 * `app.restartRunner` (main-routed; resolves once the new runner is `ready`, or fails with RUNNER_UNAVAILABLE and the
 * new failure's reason). On success every query is refetched: they failed while the runner was down.
 */
export function useRestartRunner() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => call('relay/v1/app.restartRunner', {}),
    onSuccess: (res) => {
      if (res.state === 'ready') void queryClient.invalidateQueries();
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: qk.diagnostics() });
    },
  });
}

/** `app.relaunch`: main answers, then quits and relaunches Relay (the page confirms first). */
export function useRelaunch() {
  return useMutation({ mutationFn: () => call('relay/v1/app.relaunch', {}) });
}

/**
 * `app.restoreLatestBackup`: only while the runner is unavailable. The damaged database is moved aside, never deleted;
 * `restored: false` = no usable backup (nothing changed).
 */
export function useRestoreLatestBackup() {
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: () => call('relay/v1/app.restoreLatestBackup', {}),
    // Hook-level callbacks: they run even when the shell banner that started the restore unmounts (the runner is back),
    // so the outcome is also a toast.
    onSuccess: (res) => {
      if (!res.restored) return;
      if (res.runnerState !== 'ready') {
        // The backup is in place, but the runner is still down: never a success toast.
        toast.show({
          key: 'runner:restored',
          title: 'Backup restored, but the runner still could not start',
          body: 'See the runner banner or Settings → Diagnostics for the reason. Nothing was deleted.',
          tone: 'danger',
        });
        return;
      }
      toast.show({
        key: 'runner:restored',
        title: 'Backup restored',
        body: `${res.backupCreatedAt === null ? 'Relay restored the latest backup.' : `Relay restored the backup from ${formatDate(res.backupCreatedAt)}.`}${res.previousMovedToDisplayPath === null ? '' : ` The damaged data was moved to ${res.previousMovedToDisplayPath}. Nothing was deleted.`}`,
        tone: 'success',
      });
      void queryClient.invalidateQueries();
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: qk.diagnostics() });
    },
  });
}
