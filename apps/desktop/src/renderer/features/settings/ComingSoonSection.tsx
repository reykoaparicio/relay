import { useId } from 'react';
import { Construction } from 'lucide-react';

export interface ComingSoonSectionProps {
  readonly title: string;
  readonly description: string;
}

/** A Settings section that is not built yet (M1): the heading plus a clear "coming soon" note. */
export function ComingSoonSection({ title, description }: ComingSoonSectionProps) {
  const titleId = useId();
  return (
    <section className="card stack" aria-labelledby={titleId}>
      <h2 id={titleId}>{title}</h2>
      <p className="row" style={{ gap: 8 }}>
        <Construction aria-hidden="true" width={18} height={18} />
        <strong>Coming soon.</strong>
      </p>
      <p className="muted">{description}</p>
    </section>
  );
}
