// Runner recovery controls (E2 #3/#4), shared by the shell's runner-unavailable banner and Settings → Diagnostics:
// "Restart runner", "Quit and relaunch" (confirmed), and "Restore latest backup" (confirmed; only when the runner's
// last fatal is a damaged / newer database).
import { useState } from 'react';
import type { ReactNode } from 'react';
import { DatabaseBackup, Power, RotateCw } from 'lucide-react';
import type { RunnerFatal, RunnerState } from '@relay/contracts';
import { Button, ConfirmDialog, InlineAlert } from '../../components/ui';
import { appErrorOf, errorReason, fatalOffersRestore, runnerFatalText, toViewError } from '../../api/errors';
import { formatDate } from '../../lib/format';
import { useRelaunch, useRestartRunner, useRestoreLatestBackup } from './useRunnerRecovery';

export interface RunnerRecoveryProps {
  /** `Diagnostics.runner.lastFatal` (null/undefined while none is recorded). */
  readonly fatal: RunnerFatal | null | undefined;
  /** Smaller buttons (the shell banner). */
  readonly compact?: boolean;
  /** Extra controls at the end of the button row (e.g. the banner's "Open diagnostics"). */
  readonly extra?: ReactNode;
}

/** Why a restart failed again, in words: the new failure's curated reason when it carries one. */
function restartFailureText(e: unknown): string {
  const error = appErrorOf(e);
  const reason = errorReason(error);
  if (error !== null && reason !== null) {
    const code = error.details?.['fatalCode'];
    return runnerFatalText({
      code: typeof code === 'string' ? (code as RunnerFatal['code']) : error.code,
      reason,
      message: error.userMessage,
      at: 0 as RunnerFatal['at'],
    });
  }
  return toViewError(e).userMessage;
}

/** Why the runner is still down after a restore: its recorded fatal in words, else its state. */
function stillDownReason(fatal: RunnerFatal | null | undefined, state: RunnerState): string {
  if (fatal !== null && fatal !== undefined) return runnerFatalText(fatal);
  return state === 'unavailable' ? 'it is unavailable.' : `it is still ${state === 'restarting' ? 'restarting' : 'starting'}.`;
}

/** The recovery buttons plus the outcome of the last restart / restore / relaunch. */
export function RunnerRecovery({ fatal, compact = false, extra }: RunnerRecoveryProps) {
  const restart = useRestartRunner();
  const relaunch = useRelaunch();
  const restore = useRestoreLatestBackup();
  const [confirm, setConfirm] = useState<'relaunch' | 'restore' | null>(null);
  const size = compact ? 'sm' : undefined;
  const busy = restart.isPending || relaunch.isPending || restore.isPending;
  const offerRestore = fatalOffersRestore(fatal);
  const restored = restore.data;

  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <Button
          variant="primary"
          icon={RotateCw}
          {...(size === undefined ? {} : { size })}
          pending={restart.isPending}
          disabled={busy && !restart.isPending}
          onClick={() => {
            restore.reset();
            restart.mutate();
          }}
        >
          Restart runner
        </Button>
        {offerRestore ? (
          <Button
            icon={DatabaseBackup}
            {...(size === undefined ? {} : { size })}
            disabled={busy}
            onClick={() => {
              setConfirm('restore');
            }}
          >
            Restore latest backup
          </Button>
        ) : null}
        <Button
          variant="ghost"
          icon={Power}
          {...(size === undefined ? {} : { size })}
          disabled={busy}
          onClick={() => {
            setConfirm('relaunch');
          }}
        >
          Quit and relaunch
        </Button>
        {extra}
      </div>

      {restart.isError ? (
        <InlineAlert tone="danger" live="assertive" title="The runner could not be restarted">
          <p>{restartFailureText(restart.error)}</p>
        </InlineAlert>
      ) : null}
      {restart.data === undefined ? null : restart.data.restarted ? (
        <InlineAlert
          tone="success"
          live="polite"
          title={restart.data.state === 'ready' ? 'The background runner is running again' : 'The background runner is starting'}
        />
      ) : (
        <InlineAlert tone="info" live="polite" title="The background runner is already running">
          <p>Nothing needed a restart.</p>
        </InlineAlert>
      )}
      {restore.isError ? (
        <InlineAlert tone="danger" live="assertive" title="The backup could not be restored">
          <p>{toViewError(restore.error).userMessage}</p>
        </InlineAlert>
      ) : null}
      {restored === undefined ? null : restored.restored && restored.runnerState !== 'ready' ? (
        // The backup is in place but the runner is still down: a failure with the reason, never a success.
        <InlineAlert tone="danger" live="assertive" title={`Backup restored, but the runner still could not start: ${stillDownReason(fatal, restored.runnerState)}`}>
          <p>
            Relay restored the backup
            {restored.backupCreatedAt === null ? '' : ` from ${formatDate(restored.backupCreatedAt)}`}
            {restored.previousMovedToDisplayPath === null ? '.' : <>; the previous data was moved to <span className="mono">{restored.previousMovedToDisplayPath}</span>.</>}{' '}
            Nothing was deleted. Try Restart runner, or Quit and relaunch.
          </p>
        </InlineAlert>
      ) : restored.restored ? (
        <InlineAlert tone="success" live="polite" title="Backup restored">
          <p>
            Relay restored the backup
            {restored.backupCreatedAt === null ? '' : ` from ${formatDate(restored.backupCreatedAt)}`}
            {restored.restoredFromDisplayPath === null ? '.' : ':'}{' '}
            {restored.restoredFromDisplayPath === null ? null : <span className="mono">{restored.restoredFromDisplayPath}</span>}
          </p>
          {restored.previousMovedToDisplayPath === null ? null : (
            <p>
              The damaged data was moved to <span className="mono">{restored.previousMovedToDisplayPath}</span>. Nothing was
              deleted.
            </p>
          )}
        </InlineAlert>
      ) : (
        <InlineAlert tone="warning" live="polite" title="No usable backup">
          <p>Relay found no healthy backup to restore. Nothing was changed.</p>
        </InlineAlert>
      )}
      {relaunch.data?.relaunching === true ? (
        <InlineAlert tone="info" live="polite" title="Relaunching Relay…" />
      ) : null}
      {relaunch.isError ? (
        <InlineAlert tone="danger" live="assertive" title="Relay could not relaunch">
          <p>{toViewError(relaunch.error).userMessage}</p>
        </InlineAlert>
      ) : null}

      <ConfirmDialog
        open={confirm === 'relaunch'}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
        title="Quit and relaunch Relay?"
        consequences="Relay closes and opens again. Runs are paused safely and continue from their last checkpoint."
        confirmLabel="Quit and relaunch"
        cancelLabel="Cancel"
        destructive={false}
        pending={relaunch.isPending}
        onConfirm={() => {
          relaunch.mutate(undefined, {
            onSettled: () => {
              setConfirm(null);
            },
          });
        }}
      />
      <ConfirmDialog
        open={confirm === 'restore'}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
        title="Restore the latest backup?"
        consequences="Relay replaces its database with the newest healthy backup and restarts the runner. The current data is moved aside to a folder next to it, not deleted. Changes made after the backup are not in the restored copy."
        confirmLabel="Restore backup"
        cancelLabel="Cancel"
        destructive={false}
        pending={restore.isPending}
        onConfirm={() => {
          restart.reset();
          restore.mutate(undefined, {
            onSettled: () => {
              setConfirm(null);
            },
          });
        }}
      />
    </div>
  );
}

/** The runner's last fatal in plain words, or null. */
export function RunnerFatalText({ fatal }: { readonly fatal: RunnerFatal | null | undefined }) {
  if (fatal === null || fatal === undefined) return null;
  return <p>{runnerFatalText(fatal)}</p>;
}
