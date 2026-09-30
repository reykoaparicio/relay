import { Construction } from 'lucide-react';
import { EmptyState, PageHeader } from '../components/ui';
import { useNavPerf } from '../hooks/useNavPerf';
import type { NavRoute } from '../hooks/useNavPerf';

export interface PlaceholderPageProps {
  readonly route: NavRoute;
  readonly title: string;
}

/**
 * Wave 1 stand-in for a page that lands in a later milestone (10 J1). It renders inside the shell with the page's
 * `h1`, and still records the `relay:nav:<route>` measure so the @m1 navigation specs can time every route.
 */
export function PlaceholderPage({ route, title }: PlaceholderPageProps) {
  useNavPerf(route, true);
  return (
    <>
      <PageHeader title={title} />
      <EmptyState icon={Construction} title="Coming soon" body="This page arrives in a later milestone." />
    </>
  );
}
