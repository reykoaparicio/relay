/**
 * Full window reload. A failed lazy page import stays failed for this document (React.lazy keeps the rejected
 * promise, and the browser may cache the failed module), so re-rendering cannot recover it; only a reload can.
 */
export function reloadApp(): void {
  window.location.reload();
}
