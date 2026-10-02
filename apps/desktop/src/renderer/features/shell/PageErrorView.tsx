import { useRouteError } from 'react-router';
import type { AppError } from '@relay/contracts';
import { ErrorView, PageHeader } from '../../components/ui';
import { toViewError } from '../../api/errors';
import { useNextAction } from '../common/useNextAction';
import { reloadApp } from './reload';

/**
 * Page-level router error boundary (inside the shell): a page whose code failed to load (a lazy chunk import
 * rejected) or that crashed while rendering replaces only the page; the navigation stays usable, and navigating away
 * clears the error. "Reload" reloads the window: a failed import cannot be retried in place.
 */
export function PageErrorView() {
  const routeError = useRouteError();
  const base = toViewError(routeError);
  const error: AppError = {
    ...base,
    userMessage: 'Relay could not show this page. Reload the window to try again; your runs and data are not affected.',
    nextAction: 'reload',
    alternatives: ['report_bug'],
  };
  const onAction = useNextAction({ reload: reloadApp });
  return (
    <>
      <PageHeader title="This page failed to load" />
      <ErrorView error={error} onAction={onAction} live="assertive" />
    </>
  );
}
