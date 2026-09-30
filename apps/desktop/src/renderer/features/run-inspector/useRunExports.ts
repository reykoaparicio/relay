import { useMutation } from '@tanstack/react-query';
import type { ExportWhat } from '@relay/contracts';
import { call } from '../../api/client';
import { planRunAction } from './run-actions';

/**
 * `artifacts.export` (main shows the save dialog). `report` / `patch` go through the run-action mapping
 * (`export_report` / `export_patch`); the report page's "both" is a plain export of both artifacts.
 * `exported: false` means the user cancelled the save dialog.
 */
export function useArtifactExport(runId: string) {
  return useMutation({
    mutationFn: async (what: ExportWhat) => {
      if (what === 'both') return call('relay/v1/artifacts.export', { runId, what });
      const plan = planRunAction({ action: what === 'report' ? 'export_report' : 'export_patch', runId });
      if (plan.kind !== 'call' || plan.channel !== 'relay/v1/artifacts.export') throw new Error('export maps to an unexpected op');
      return call(plan.channel, plan.input);
    },
  });
}

/** `ledger.export({ runId })`: the run's ledger as CSV (main shows the save dialog). */
export function useLedgerExport(runId: string) {
  return useMutation({ mutationFn: () => call('relay/v1/ledger.export', { runId }) });
}
