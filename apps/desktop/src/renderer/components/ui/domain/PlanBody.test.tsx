import { describe, expect, it } from 'vitest';
import { render, within } from '@testing-library/react';
import { plan } from '../test-fixtures';
import { PlanBody } from './PlanBody';

describe('PlanBody', () => {
  it('keeps each step title and its detail apart (separate paragraphs, never run together)', () => {
    const { container } = render(<PlanBody plan={plan()} />);
    const list = container.querySelector('ol');
    if (list === null) throw new Error('no step list');
    const steps = within(list).getAllByRole('listitem');
    expect(steps).toHaveLength(2);
    const first = steps[0];
    if (first === undefined) throw new Error('no step');
    const paragraphs = first.querySelectorAll(':scope > p');
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0]).toHaveTextContent('1. Add a schema for the create-user payload');
    expect(paragraphs[1]).toHaveTextContent('Finding F1 · addresses F1');
  });
});
