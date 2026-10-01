import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { takeFields, useRebasableForm } from './useRebasableForm';
import type { RebasableFormConfig } from './useRebasableForm';

interface Doc {
  readonly rev: number;
  readonly title: string;
  readonly body: string;
}
type Values = Pick<Doc, 'title' | 'body'>;
const FIELDS = ['title', 'body'] as const;

function config(server: Doc): RebasableFormConfig<Doc, Values> {
  return {
    server,
    valuesOf: (d) => ({ title: d.title, body: d.body }),
    isNewer: (s, b) => s.rev > b.rev,
    isDirty: (v, b) => FIELDS.some((f) => v[f] !== b[f]),
    merge: (b, mine, theirs) => takeFields(theirs, mine, FIELDS.filter((f) => mine[f] !== b[f])),
  };
}

const V1: Doc = { rev: 1, title: 'A', body: 'one' };
const V2: Doc = { rev: 2, title: 'B', body: 'one' };

describe('useRebasableForm', () => {
  it('an untouched form follows a newer server version silently', () => {
    const { result, rerender } = renderHook(({ server }) => useRebasableForm(config(server)), { initialProps: { server: V1 } });

    rerender({ server: V2 });

    expect(result.current.base).toBe(V2);
    expect(result.current.values).toEqual({ title: 'B', body: 'one' });
    expect(result.current.serverAhead).toBe(false);
  });

  it('with edits, a newer version is reported (serverAhead) and never applied behind the user', () => {
    const { result, rerender } = renderHook(({ server }) => useRebasableForm(config(server)), { initialProps: { server: V1 } });
    act(() => {
      result.current.setValues((v) => ({ ...v, body: 'mine' }));
    });

    rerender({ server: V2 });

    expect(result.current.serverAhead).toBe(true);
    expect(result.current.base).toBe(V1);
    expect(result.current.values).toEqual({ title: 'A', body: 'mine' });
    expect(result.current.serverValues).toEqual({ title: 'B', body: 'one' });
  });

  it("rebase keeps the user's changed fields over the server's and moves the base", () => {
    const { result, rerender } = renderHook(({ server }) => useRebasableForm(config(server)), { initialProps: { server: V1 } });
    act(() => {
      result.current.setValues((v) => ({ ...v, body: 'mine' }));
    });
    rerender({ server: V2 });
    let merged: Values | undefined;

    act(() => {
      merged = result.current.rebase();
    });

    expect(merged).toEqual({ title: 'B', body: 'mine' });
    expect(result.current.values).toEqual({ title: 'B', body: 'mine' });
    expect(result.current.base).toBe(V2);
    expect(result.current.serverAhead).toBe(false);
    expect(result.current.dirty).toBe(true);
  });

  it('markSaved makes the saved version the base and keeps edits typed meanwhile by default', () => {
    const { result } = renderHook(() => useRebasableForm(config(V1)));
    act(() => {
      result.current.setValues((v) => ({ ...v, title: 'Saved title' }));
    });
    const saved: Doc = { rev: 2, title: 'Saved title', body: 'one' };

    act(() => {
      result.current.markSaved(saved);
    });

    expect(result.current.base).toBe(saved);
    expect(result.current.dirty).toBe(false);
  });

  it('an older server version (e.g. the list before the save lands) never replaces the base', () => {
    const { result, rerender } = renderHook(({ server }) => useRebasableForm(config(server)), { initialProps: { server: V2 } });

    rerender({ server: V1 });

    expect(result.current.base).toBe(V2);
    expect(result.current.serverAhead).toBe(false);
  });
});
