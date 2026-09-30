import { FlaskConical } from 'lucide-react';

/** Persistent shell badge while providerMode is 'fake' (§22.2 honesty): no real model is called. */
export function FakeProviderBadge() {
  return (
    <span className="fake-badge">
      <FlaskConical aria-hidden="true" />
      Fake provider: no real model calls
    </span>
  );
}
