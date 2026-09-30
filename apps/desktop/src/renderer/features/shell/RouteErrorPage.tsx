import { useRouteError } from 'react-router';
import { ErrorView, PageHeader } from '../../components/ui';
import { toViewError } from '../../api/errors';

/** Router error boundary: a render crash shows a recoverable error instead of a blank window. */
export function RouteErrorPage() {
  const error = useRouteError();
  return (
    <main id="main" className="main" tabIndex={-1}>
      <div className="main-inner">
        <PageHeader title="Something went wrong" />
        <ErrorView
          error={toViewError(error)}
          onAction={() => {
            window.location.reload();
          }}
        />
      </div>
    </main>
  );
}
