import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { axe, describeViolations } from './test-utils';
import { ButtonLink } from './ButtonLink';
import { StatTile } from './StatTile';

describe('StatTile', () => {
  it('without href or secondary action is plain content', () => {
    render(<StatTile label="Runs" value="12" hint="this week" />);

    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('Runs')).toHaveClass('label');
    expect(screen.getByText('12')).toHaveClass('value');
  });

  it('with only href the whole tile is one link named by its text', () => {
    render(<StatTile label="Active runs" value="1" hint="Waiting for your approval" href="#/runs" />);
    const link = screen.getByRole('link');

    expect(link).toHaveClass('card', 'stat');
    expect(link).toHaveAccessibleName('Active runs 1 Waiting for your approval');
  });

  it('shows labelAside beside the label and includes it in the link name', () => {
    render(<StatTile label="Usage tracked by Relay" labelAside="September" value="$1.24" href="#/usage" />);

    expect(screen.getByText('September')).toHaveClass('label-aside');
    expect(screen.getByText('September').parentElement).toHaveClass('label-row');
    expect(screen.getByRole('link')).toHaveAccessibleName('Usage tracked by Relay September $1.24');
  });

  it('renders the secondary action outside the primary link so links never nest', () => {
    render(
      <StatTile
        label="Usage tracked by Relay"
        labelAside="September"
        value="$1.24"
        hint="$0.36 reserved in flight"
        href="#/usage"
        secondaryAction={<a href="#/ledger">Open usage ledger</a>}
      />,
    );
    const primary = screen.getByRole('link', { name: /Usage tracked by Relay/ });
    const secondary = screen.getByRole('link', { name: 'Open usage ledger' });

    expect(primary).toHaveClass('stat-main');
    expect(primary).not.toHaveClass('card');
    expect(primary.contains(secondary)).toBe(false);
    expect(secondary.contains(primary)).toBe(false);
    expect(primary.closest('.card.stat')).toBe(secondary.closest('.card.stat'));
    expect(document.querySelectorAll('a a')).toHaveLength(0);
  });

  it('renders a secondary action on a tile without href', () => {
    render(<StatTile label="Project memory" value="8" hint="approved records" secondaryAction={<ButtonLink href="#/memory" size="sm">2 suggestions to review</ButtonLink>} />);

    expect(screen.getAllByRole('link')).toHaveLength(1);
    expect(screen.getByRole('link', { name: '2 suggestions to review' }).closest('.stat-secondary')).not.toBeNull();
  });

  it('has no axe violations in every shape @a11y', async () => {
    const { baseElement } = render(
      <main>
        <StatTile label="Runs" value="12" />
        <StatTile label="Active runs" value="1" href="#/runs" />
        <StatTile label="Usage tracked by Relay" labelAside="September" value="$1.24" hint="$0.36 reserved" href="#/usage" secondaryAction={<a href="#/ledger">Open usage ledger</a>} />
        <StatTile label="Project memory" value="8" secondaryAction={<ButtonLink href="#/memory">Manage memory</ButtonLink>} />
      </main>,
    );

    expect(describeViolations(await axe(baseElement))).toEqual([]);
  });
});
