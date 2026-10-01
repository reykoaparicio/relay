// `app.openExternal` (08 H4, §11.4): main shows a native confirmation and opens only https URLs. The renderer never
// navigates to an external URL itself (window.open and navigation away are blocked, 08 H8).
import { useMutation } from '@tanstack/react-query';
import { call } from '../../api/client';

/** Opens an https URL in the default browser after the user confirms in main. */
export function useOpenExternal() {
  return useMutation({ mutationFn: (url: string) => call('relay/v1/app.openExternal', { url }) });
}
