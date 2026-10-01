// 06 F1: the runner handler types — the parsed input of a runner channel, one handler, and the exhaustive table type.
import type { INTERNAL_RUNNER_OPS, OPERATIONS, Result, RunnerChannel, RunnerOutputOf } from '@relay/contracts';

type Ops = typeof OPERATIONS & typeof INTERNAL_RUNNER_OPS;
type DefOf<C> = Extract<Ops[keyof Ops], { channel: C }>;
/** Parsed (schema output) input of a runner channel. */
export type ParsedInputOf<C extends RunnerChannel> = DefOf<C>['input']['_zod']['output'];
/** One runner handler. */
export type Handler<C extends RunnerChannel> = (input: ParsedInputOf<C>) => Promise<Result<RunnerOutputOf<C>>>;
/** The exhaustive handler table (F1). */
export type HandlerTable = { readonly [C in RunnerChannel]: Handler<C> };
