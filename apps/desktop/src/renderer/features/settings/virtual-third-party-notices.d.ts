// LIC-01: the build-generated license list (build/vite-plugin-third-party-notices.ts). Keep in sync with
// `ThirdPartyNotices` there (the renderer tsconfig cannot import build/).
declare module 'virtual:third-party-notices' {
  /** Packages that share one identical license text. */
  export interface NoticeGroup {
    /** Distinct SPDX ids of the group's packages, joined with " / ". */
    readonly license: string;
    readonly text: string;
    readonly packages: readonly { readonly name: string; readonly version: string }[];
  }
  /** Every third-party package bundled into Relay, grouped by license text. */
  export interface ThirdPartyNotices {
    /** True when the list does not cover every build (dev server, renderer-only build). */
    readonly partial: boolean;
    readonly packageCount: number;
    readonly groups: readonly NoticeGroup[];
  }
  const notices: ThirdPartyNotices;
  export default notices;
}
