import { createRef } from 'react';
import type { AnchorHTMLAttributes, Ref } from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ArrowRight } from 'lucide-react';
import { Link, MemoryRouter, Route, Routes } from 'react-router';
import { axe, describeViolations } from './test-utils';
import { ButtonLink } from './ButtonLink';

describe('ButtonLink', () => {
  it('renders a plain <a> link with the button classes by default', () => {
    render(<ButtonLink href="#/runs">Open runs</ButtonLink>);
    const link = screen.getByRole('link', { name: 'Open runs' });

    expect(link.tagName).toBe('A');
    expect(link).toHaveAttribute('href', '#/runs');
    expect(link).toHaveClass('btn');
    expect(link).not.toHaveClass('secondary', 'md');
  });

  it('applies the same variant and size classes as Button', () => {
    render(
      <>
        <ButtonLink href="#a" variant="primary" size="lg">Primary</ButtonLink>
        <ButtonLink href="#b" variant="danger" size="sm">Danger</ButtonLink>
        <ButtonLink href="#c" variant="ghost" className="extra">Ghost</ButtonLink>
      </>,
    );

    expect(screen.getByRole('link', { name: 'Primary' })).toHaveClass('btn', 'primary', 'lg');
    expect(screen.getByRole('link', { name: 'Danger' })).toHaveClass('btn', 'danger', 'sm');
    expect(screen.getByRole('link', { name: 'Ghost' })).toHaveClass('btn', 'ghost', 'extra');
  });

  it('keeps the icon decorative and nests no interactive element', () => {
    render(<ButtonLink href="#/runs/24" icon={ArrowRight}>Review recovery options</ButtonLink>);
    const link = screen.getByRole('link', { name: 'Review recovery options' });

    expect(link.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expect(link.querySelectorAll('a, button, input, select, textarea, [tabindex]')).toHaveLength(0);
  });

  it('renders through a custom component passed as `as` and forwards its props and ref', () => {
    function CustomLink({ to, ref, children, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string; ref?: Ref<HTMLAnchorElement> }) {
      return <a {...rest} ref={ref} href={`#${to}`} data-custom="">{children}</a>;
    }
    const ref = createRef<HTMLAnchorElement>();
    render(<ButtonLink as={CustomLink} to="/memory" ref={ref} variant="primary">Manage memory</ButtonLink>);
    const link = screen.getByRole('link', { name: 'Manage memory' });

    expect(link).toHaveAttribute('href', '#/memory');
    expect(link).toHaveAttribute('data-custom');
    expect(link).toHaveClass('btn', 'primary');
    expect(ref.current).toBe(link);
  });

  it('navigates with react-router Link via `as={Link}`', async () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<ButtonLink as={Link} to="/runs" variant="primary">Open runs</ButtonLink>} />
          <Route path="/runs" element={<h1>Runs page</h1>} />
        </Routes>
      </MemoryRouter>,
    );

    await userEvent.click(screen.getByRole('link', { name: 'Open runs' }));

    expect(screen.getByRole('heading', { name: 'Runs page' })).toBeInTheDocument();
  });

  it('has no axe violations @a11y', async () => {
    const { baseElement } = render(
      <main>
        <ButtonLink href="#/a" variant="primary" icon={ArrowRight}>Review recovery options</ButtonLink>
        <ButtonLink href="#/b">Open usage ledger</ButtonLink>
      </main>,
    );

    expect(describeViolations(await axe(baseElement))).toEqual([]);
  });
});
