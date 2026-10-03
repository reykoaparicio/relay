/// <reference types="electron-vite/node" />

interface ImportMetaEnv {
  /**
   * Build-time flag (electron-vite inlines `MAIN_VITE_*` from the build environment): `1` lets a PACKAGED build honor
   * RELAY_E2E=1 (scripts/verify-package.ts). Unset in release builds, where RELAY_E2E and every dev override are ignored.
   */
  readonly MAIN_VITE_RELAY_PACKAGED_E2E?: string;
}
