// LIC-01: the only module that references the build-generated `virtual:third-party-notices`
// (build/vite-plugin-third-party-notices.ts). AboutSection loads THIS module lazily, so code paths that never open
// About — and test environments without the build plugin — never resolve the virtual id; About tests mock this module.
import type { ThirdPartyNotices } from 'virtual:third-party-notices';

export type { NoticeGroup, ThirdPartyNotices } from 'virtual:third-party-notices';

/** Loads the license list (its own chunk: only Settings → About pays for it). */
export async function loadThirdPartyNotices(): Promise<ThirdPartyNotices> {
  return (await import('virtual:third-party-notices')).default;
}
