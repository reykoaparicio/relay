import { useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';

/**
 * A form edited against a *base* version of a server object (DUP-01): the project settings, a workflow draft, a memory
 * record. Saves send the form diffed against the base and expect the base's revision; a newer server version never
 * replaces the user's edits behind their back.
 */
export interface RebasableFormConfig<S, V> {
  /** The latest version the cache holds (refetches, pushes, a reload after a CONFLICT). */
  readonly server: S;
  /** The form values of a version. */
  readonly valuesOf: (version: S) => V;
  /** True when `server` is a newer version than `base` (never for the same or an older one). */
  readonly isNewer: (server: S, base: S) => boolean;
  /** True when the form differs from the base (the user has edits). */
  readonly isDirty: (values: V, baseValues: V, base: S) => boolean;
  /** "Keep my changes on top of the newer version": the user's changed fields over the server's values. */
  readonly merge: (baseValues: V, mine: V, serverValues: V) => V;
}

export interface RebasableForm<S, V> {
  /** The version the user is editing against: the patch is computed against it and a save expects its revision. */
  readonly base: S;
  readonly baseValues: V;
  readonly values: V;
  readonly setValues: Dispatch<SetStateAction<V>>;
  readonly dirty: boolean;
  /** A newer server version exists while the user has edits: show `ServerChangesNotice`, block a plain save. */
  readonly serverAhead: boolean;
  readonly serverValues: V;
  /** Moves the base to the server version, keeping the user's changes; returns the merged values. */
  readonly rebase: () => V;
  /**
   * A save succeeded: `saved` is the new base. `keep` decides the values (default: unchanged, i.e. edits typed while
   * the save was in flight stay).
   */
  readonly markSaved: (saved: S, keep?: (current: V, savedValues: V) => V) => void;
}

/**
 * Base-revision bookkeeping shared by every edit form whose save expects a revision. An untouched form follows a newer
 * server version silently; with edits, the newer version is only reported (`serverAhead`) until the user rebases.
 */
export function useRebasableForm<S, V>({ server, valuesOf, isNewer, isDirty, merge }: RebasableFormConfig<S, V>): RebasableForm<S, V> {
  const [base, setBase] = useState(server);
  const [values, setValues] = useState<V>(() => valuesOf(server));
  const baseValues = valuesOf(base);
  const dirty = isDirty(values, baseValues, base);
  const newer = isNewer(server, base);
  // Render-time adoption (React's "adjust state while rendering"): an untouched form shows the newer version at once.
  if (newer && !dirty) {
    setBase(server);
    setValues(valuesOf(server));
  }
  const serverValues = valuesOf(server);
  const rebase = (): V => {
    const merged = merge(baseValues, values, serverValues);
    setValues(merged);
    setBase(server);
    return merged;
  };
  const markSaved = (saved: S, keep?: (current: V, savedValues: V) => V) => {
    setBase(saved);
    if (keep !== undefined) setValues((current) => keep(current, valuesOf(saved)));
  };
  return { base, baseValues, values, setValues, dirty, serverAhead: newer && dirty, serverValues, rebase, markSaved };
}

/** `theirs` with the listed fields taken from `mine` (a typed per-field merge, no casts). */
export function takeFields<V extends object>(theirs: V, mine: V, fields: readonly (keyof V)[]): V {
  return fields.reduce<V>((acc, f) => ({ ...acc, [f]: mine[f] }), theirs);
}
