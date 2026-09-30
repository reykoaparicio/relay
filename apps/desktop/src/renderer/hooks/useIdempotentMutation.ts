import { useCallback, useLayoutEffect, useRef } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { Channel, InputOf, OutputOf } from '@relay/contracts';
import { call } from '../api/client';
import { newIdempotencyKey } from '../api/idempotency';

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
  /** Fire-and-forget submit. A second submit while one is in flight is ignored (no double start). */
  readonly mutate: (input: IntentInput<C>) => void;
  /** Awaitable submit. While in flight, returns the in-flight promise. */
  readonly mutateAsync: (input: IntentInput<C>) => Promise<OutputOf<C>>;
  readonly isPending: boolean;
  readonly error: unknown;
  readonly data: OutputOf<C> | undefined;
  /** Starts a new user intent (call when the form changes): the next submit gets a fresh key. */
  readonly newIntent: () => void;
  /** The key the current intent uses, or null before the first submit of an intent. */
  readonly currentKey: () => string | null;
}

/**
 * Mutation for an idempotent command (10 J2). One `idempotencyKey` per user intent: generated on the first submit,
 * reused by retries of the same intent (after an error), and reset after success or by {@link newIntent}. A
 * double-click therefore sends one request, and a retry never double-starts (02 §B0).
 */
export function useIdempotentMutation<C extends IdemChannel>(
  channel: C,
  options: IdempotentMutationOptions<C> = {},
): IdempotentMutation<C> {
  const keyRef = useRef<string | null>(null);
  const inFlight = useRef<Promise<OutputOf<C>> | null>(null);
  const optionsRef = useRef(options);
  useLayoutEffect(() => {
    optionsRef.current = options;
  });
  const mutation = useMutation<OutputOf<C>, unknown, InputOf<C>>({
    mutationFn: (input) => call(channel, input),
  });
  const { mutateAsync: rawMutateAsync } = mutation;

  const mutateAsync = useCallback(
    (input: IntentInput<C>): Promise<OutputOf<C>> => {
      if (inFlight.current !== null) return inFlight.current;
      keyRef.current ??= newIdempotencyKey();
      const full = { ...input, idempotencyKey: keyRef.current } as unknown as InputOf<C>;
      const promise = rawMutateAsync(full).then(
        (data) => {
          keyRef.current = null;
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
      inFlight.current = promise;
      return promise;
    },
    [rawMutateAsync],
  );

  const mutate = useCallback(
    (input: IntentInput<C>) => {
      mutateAsync(input).catch(() => undefined);
    },
    [mutateAsync],
  );

  const newIntent = useCallback(() => {
    if (inFlight.current === null) keyRef.current = null;
  }, []);
  const currentKey = useCallback(() => keyRef.current, []);

  return {
    mutate,
    mutateAsync,
    isPending: mutation.isPending,
    error: mutation.error,
    data: mutation.data,
    newIntent,
    currentKey,
  };
}
