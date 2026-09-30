/**
 * Exhaustiveness helper for `switch` statements over unions (00b §2.2).
 * @throws Error always; reaching it at runtime is a bug.
 */
export function assertNever(x: never, msg?: string): never {
  throw new Error(msg ?? `Unexpected value: ${JSON.stringify(x)}`);
}

/**
 * Asserts an invariant. Use for bugs only; expected failures are returned as `Result` (00b §2.2).
 * @throws Error when `cond` is falsy.
 */
export function invariant(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    throw new Error(`Invariant violation: ${msg}`);
  }
}
