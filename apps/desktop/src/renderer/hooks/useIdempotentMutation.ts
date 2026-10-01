import { useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import { useMutation } from '@tanstack/react-query';
import { appError } from '@relay/contracts';
import type { Channel, InputOf, OutputOf } from '@relay/contracts';
import { AppErrorException, call } from '../api/client';
import { newIdempotencyKey } from '../api/idempotency';

/** User-facing text when a different request is submitted while another is still in flight. */
const INTENT_IN_FLIGHT_MESSAGE = 'Another request is still in progress. Wait for it to finish, then try again.';

/**
 * Rejection for a submit whose input differs from the request in flight on the same channel. It is never resolved
 * with the other request's result (that would report a different action as done).
 */
export class IntentInFlightError extends AppErrorException {
  constructor(channel?: Channel) {
    super(
      appError('CONFLICT', {
        userMessage: INTENT_IN_FLIGHT_MESSAGE,
        details: { reason: 'intent_in_flight', ...(channel === undefined ? {} : { channel }) },
      }),
    );
    this.name = 'IntentInFlightError';
  }
}

/** Stable JSON of a value with object keys sorted (the intent fingerprint; `undefined` fields are dropped). */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return v;
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) sorted[k] = (v as Record<string, unknown>)[k];
    return sorted;
  });
}

/** The intent a submit belongs to: (channel, canonical input). */
function intentFingerprint(channel: Channel, input: unknown): string {
  return `${channel}\u0000${canonicalJson(input)}`;
}

/** Channels whose input carries an `idempotencyKey` (02 §B0 `Idem` commands). */
export type IdemChannel = {
  [C in Channel]: InputOf<C> extends { readonly idempotencyKey: string } ? C : never;
}[Channel];

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** Input without the key: the hook supplies it. */
export type IntentInput<C extends IdemChannel> = DistributiveOmit<InputOf<C>, 'idempotencyKey'>;

export interface IdempotentMutationOptions<C extends IdemChannel> {
  readonly onSuccess?: (data: OutputOf<C>, input: IntentInput<C>) => void;
  readonly onError?: (error: unknown, input: IntentInput<C>) => void;
}

export interface IdempotentMutation<C extends IdemChannel> {
  /**
   * Fire-and-forget submit. A second submit of the same intent while one is in flight is deduped (no double start).
   * `intentTag` is part of the intent but is not sent: state the input does not carry (e.g. the draft revision a
   * `workflows.publish` publishes) so that a submit about different state never reuses an earlier key.
   */
  readonly mutate: (input: IntentInput<C>, intentTag?: string) => void;
  /**
   * Awaitable submit. The same intent (equal canonical input and tag) while in flight returns the in-flight promise; a
   * different intent while another is in flight rejects with {@link IntentInFlightError} (never A's result).
   */
  readonly mutateAsync: (input: IntentInput<C>, intentTag?: string) => Promise<OutputOf<C>>;
  readonly isPending: boolean;
  readonly error: unknown;
  readonly data: OutputOf<C> | undefined;
  /** Starts a new user intent (call when the form changes): the next submit gets a fresh key. */
  readonly newIntent: () => void;
  /** The key the current intent uses, or null before the first submit of an intent. */
  readonly currentKey: () => string | null;
  /** Clears the error/result and starts a new intent (e.g. a dialog closed or its form was reset). */
  readonly reset: () => void;
}

/**
 * Mutation for an idempotent command (10 J2). One `idempotencyKey` per user intent, where the intent is
 * (channel, canonical input): generated on the first submit, reused by retries of the same intent (after an error),
 * and reset after success, by {@link newIntent}, or when the input changes. A double-click therefore sends one
 * request, a retry never double-starts (02 §B0), and a different request never reuses another request's key.
 */
export function useIdempotentMutation<C extends IdemChannel>(
  channel: C,
  options: IdempotentMutationOptions<C> = {},
): IdempotentMutation<C> {
  const intentRef = useRef<{ readonly fingerprint: string; readonly key: string } | null>(null);
  const inFlight = useRef<{ readonly fingerprint: string; readonly promise: Promise<OutputOf<C>> } | null>(null);
  const optionsRef = useRef(options);
  useLayoutEffect(() => {
    optionsRef.current = options;
  });
  const mutation = useMutation<OutputOf<C>, unknown, InputOf<C>>({
    mutationFn: (input) => call(channel, input),
  });
  const { mutateAsync: rawMutateAsync, reset: rawReset } = mutation;

  const mutateAsync = useCallback(
    (input: IntentInput<C>, intentTag?: string): Promise<OutputOf<C>> => {
      const fingerprint = `${intentFingerprint(channel, input)}${intentTag === undefined ? '' : `\u0000${intentTag}`}`;
      if (inFlight.current !== null) {
        if (inFlight.current.fingerprint === fingerprint) return inFlight.current.promise;
        return Promise.reject(new IntentInFlightError(channel));
      }
      if (intentRef.current?.fingerprint !== fingerprint) intentRef.current = { fingerprint, key: newIdempotencyKey() };
      const full = { ...input, idempotencyKey: intentRef.current.key } as unknown as InputOf<C>;
      const promise = rawMutateAsync(full).then(
        (data) => {
          intentRef.current = null;
          inFlight.current = null;
          optionsRef.current.onSuccess?.(data, input);
          return data;
        },
        (error: unknown) => {
          // Keep the key: retrying the same intent must be recognised as the same request.
          inFlight.current = null;
          optionsRef.current.onError?.(error, input);
          throw error;
        },
      );
      inFlight.current = { fingerprint, promise };
      return promise;
    },
    [channel, rawMutateAsync],
  );

  const mutate = useCallback(
    (input: IntentInput<C>, intentTag?: string) => {
      mutateAsync(input, intentTag).catch(() => undefined);
    },
    [mutateAsync],
  );

  const newIntent = useCallback(() => {
    if (inFlight.current === null) intentRef.current = null;
  }, []);
  const currentKey = useCallback(() => intentRef.current?.key ?? null, []);
  const reset = useCallback(() => {
    newIntent();
    rawReset();
  }, [newIntent, rawReset]);

  const { isPending, error, data } = mutation;
  // A stable object (PERF-02): consumers can list it as a dependency without re-running every render.
  return useMemo(
    () => ({ mutate, mutateAsync, isPending, error, data, newIntent, currentKey, reset }),
    [mutate, mutateAsync, isPending, error, data, newIntent, currentKey, reset],
  );
}
