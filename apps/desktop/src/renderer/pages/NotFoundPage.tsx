import { Link } from 'react-router';
import { EmptyState, PageHeader } from '../components/ui';
import { paths } from '../features/shell/paths';

/** `*` route. */
export function NotFoundPage() {
  return (
    <>
      <PageHeader title="Page not found" />
      <EmptyState
        title="There is nothing at this address"
        body="The link may be from an older version of Relay, or the item was removed."
        actions={
          <Link className="btn primary" to={paths.root()}>
            Go to overview
          </Link>
        }
      />
    </>
  );
}
