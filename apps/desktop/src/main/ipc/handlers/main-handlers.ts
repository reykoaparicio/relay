// 08 H4 main-only handlers: app.getInfo, app.openExternal (https only, confirmed in main), projects.pickDirectory.
import { invariant, toIpc } from '@relay/contracts';
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
      // The catalog input schema already admits only https URLs, so a non-https URL here is a bug in the pipeline, not
      // user input: an invariant (→ INTERNAL at the router), never an error code the operation would have to declare.
      // Kept as defense in depth: shell.openExternal must never see file:, javascript: or http: URLs.
      invariant(new URL(url).protocol === 'https:', 'app.openExternal reached the handler with a non-https URL');
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
