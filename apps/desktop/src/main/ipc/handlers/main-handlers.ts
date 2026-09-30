// 08 H4 main-only handlers: app.getInfo, app.openExternal (https only, confirmed in main), projects.pickDirectory.
import { errors, toIpc } from '@relay/contracts';
import type { AppInfo } from '@relay/contracts';
import type { DialogService } from '../../dialogs.js';
import type { HandlerTable, MainChannel } from '../types.js';

/** Dependencies of {@link createMainHandlers}. */
export interface MainHandlerDeps {
  readonly appInfo: () => AppInfo;
  readonly dialogs: DialogService;
  /** Native confirmation (§11.4: links open only after the user confirms). */
  readonly confirmOpenExternal: (url: string) => Promise<boolean>;
  readonly openExternal: (url: string) => Promise<void>;
}

/** Creates the main-only handler table. */
export function createMainHandlers(deps: MainHandlerDeps): HandlerTable<MainChannel> {
  return {
    'relay/v1/app.getInfo': () => Promise.resolve({ ok: true, data: deps.appInfo() }),
    'relay/v1/app.openExternal': async ({ url }) => {
      if (new URL(url).protocol !== 'https:') return { ok: false, error: errors.permissionDenied('outside_root') };
      if (!(await deps.confirmOpenExternal(url))) return { ok: true, data: { opened: false } };
      await deps.openExternal(url);
      return { ok: true, data: { opened: true } };
    },
    'relay/v1/projects.pickDirectory': async () => {
      const picked = await deps.dialogs.pickDirectory();
      return toIpc(picked.ok ? { ok: true, value: { selection: picked.value } } : picked);
    },
  };
}
