declare const brand: unique symbol;

/**
 * Nominal ("branded") type: `T` tagged with the compile-time-only label `B`.
 * Brands have no runtime representation; values are created through the matching Zod schema or constructor.
 */
export type Brand<T, B extends string> = T & { readonly [brand]: B };
