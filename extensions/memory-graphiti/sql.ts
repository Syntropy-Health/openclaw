/**
 * The tagged-template query shape the memory stores take. A `postgres` pool
 * satisfies it at runtime; the stores depend only on this, so tests can pass a
 * fake.
 */
export type Sql = <T = Record<string, unknown>>(
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<T[]>;
