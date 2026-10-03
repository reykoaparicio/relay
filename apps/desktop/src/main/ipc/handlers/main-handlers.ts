// 08 H4 main-only handlers: app.getInfo, app.openExternal (https only, confirmed in main), projects.pickDirectory,
// app.restartRunner (manual recovery from `unavailable`) and app.relaunch (quit + relaunch, confirmed in the renderer).
import { appError, errors, invariant, toIpc } from '@relay/contracts';
import type { AppInfo } from '@relay/contracts';
import type { MaintenanceOutcome, RestartOutcome, SupervisorSnapshot } from '../../runner-supervisor.js';
import type { DialogService } from '../../dialogs.js';
import type { HandlerTable, MainChannel } from '../types.js';

/** Dependencies of {@link createMainHandlers}. */
export interface MainHandlerDeps {
  readonly appInfo: () => AppInfo;
  readonly dialogs: DialogService;
  /** Native confirmation (§11.4: links open only after the user confirms). */
  readonly confirmOpenExternal: (url: string) => Promise<boolean>;
  readonly openExternal: (url: string) => Promise<void>;
  /** The runner supervisor's manual restart and state (app.restartRunner). */
  readonly runner: {
    restart(): Promise<RestartOutcome>;
    state(): SupervisorSnapshot;
    runMaintenance(task: 'restore_latest_backup'): Promise<MaintenanceOutcome>;
  };
  /**
   * Starts the quit-and-relaunch sequence AFTER the IPC answer was sent (graceful runner shutdown, clean-quit marker,
   * log flush, `app.relaunch()` + `app.exit(0)`).
   */
  readonly relaunch: () => void;
}

/** Creates the main-only handler table. */
export function createMainHandlers(deps: MainHandlerDeps): HandlerTable<MainChannel> {
  return {
    'relay/v1/app.getInfo': () => Promise.resolve({ ok: true, data: deps.appInfo() }),
    'relay/v1/app.openExternal': async ({ url }) => {
      // The catalog input schema already admits only https URLs, so a non-https URL here is a bug in the pipeline, not
      // user input: an invariant (→ INTERNAL at the router), never an error code the operation would have to declare.
      // Kept as defense in depth: shell.openExternal must never see file:, javascript: or http: URLs.
      invariant(new URL(url).protocol === 'https:', 'app.openExternal reached the handler with a non-https URL');
      if (!(await deps.confirmOpenExternal(url))) return { ok: true, data: { opened: false } };
      await deps.openExternal(url);
      return { ok: true, data: { opened: true } };
    },
    'relay/v1/app.restartRunner': async () => {
      const r = await deps.runner.restart();
      if (!r.restarted || r.state === 'ready') return { ok: true, data: { restarted: r.restarted, state: r.state } };
      const fatal = deps.runner.state().lastFatal;
      return {
        ok: false,
        error: appError('RUNNER_UNAVAILABLE', {
          details: { reason: fatal?.reason ?? (r.state === 'unavailable' ? 'restart_failed' : 'still_starting'), ...(fatal === null ? {} : { fatalCode: fatal.code }) },
        }),
      };
    },
    'relay/v1/app.restoreLatestBackup': async () => {
      const m = await deps.runner.runMaintenance('restore_latest_backup');
      if (!m.ok) {
        if (m.reason === 'runner_active' || m.reason === 'busy') {
          return { ok: false, error: errors.conflict({ reason: m.reason }, { userMessage: 'A backup can only be restored while the background runner is stopped.' }) };
        }
        return { ok: false, error: appError('RUNNER_UNAVAILABLE', { details: { reason: `maintenance_${m.reason}` } }) };
      }
      if (!m.result.ok) return { ok: false, error: m.result.error };
      const { restored, restoredFromDisplayPath, backupCreatedAt, previousMovedToDisplayPath } = m.result;
      const restoredFacts = { restored, restoredFromDisplayPath, backupCreatedAt, previousMovedToDisplayPath };
      // A restored database gets a fresh runner at once; with no usable backup nothing changed (the runner stays down).
      const r = m.result.restored ? await deps.runner.restart() : { state: deps.runner.state().state };
      return { ok: true, data: { ...restoredFacts, runnerState: r.state } };
    },
    'relay/v1/app.relaunch': () => {
      deps.relaunch();
      return Promise.resolve({ ok: true, data: { relaunching: true } });
    },
    'relay/v1/projects.pickDirectory': async () => {
      const picked = await deps.dialogs.pickDirectory();
      return toIpc(picked.ok ? { ok: true, value: { selection: picked.value } } : picked);
    },
  };
}
