// Handler-table typing for the main IPC router (08 H4), derived from the contracts catalog.
import type { Channel, IpcResult, OperationKey, OpRoute, OPERATIONS, RunnerChannel, RunnerInputOf } from '@relay/contracts';

type OpByChannel = { [K in OperationKey as (typeof OPERATIONS)[K]['channel']]: (typeof OPERATIONS)[K] };

/** Input of channel `C` after zod parsing (defaults applied, ids branded). */
export type ParsedIn<C extends Channel> = OpByChannel[C]['input']['_zod']['output'];

type ChannelsOfRoute<R extends OpRoute> = { [C in Channel]: OpByChannel[C]['route'] extends R ? C : never }[Channel];
/** Channels served entirely in main. */
export type MainChannel = ChannelsOfRoute<'main'>;
/** Main+runner composites. */
export type CompositeChannel = ChannelsOfRoute<'main+runner'>;

/** A typed handler table. */
export type HandlerTable<C extends Channel> = { readonly [K in C]: (input: ParsedIn<K>) => Promise<IpcResult<K>> };

/** Request options of the runner transport. */
export interface RunnerRequestOptions {
  readonly timeoutMs?: number;
}

/** The runner transport as seen by the router and composites (implemented by the supervisor). */
export interface RunnerRequester {
  request<C extends RunnerChannel>(channel: C, input: RunnerInputOf<C>, opts?: RunnerRequestOptions): Promise<IpcResult<C>>;
}
