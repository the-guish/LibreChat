/**
 * For a contract runner whose suite has cases that need a store still a stand-in on its backend
 * (a PostgreSQL store a later S unit implements): runs `describeSuite` with exactly those cases
 * skipped, each named with the store that blocks it, so the rest of the suite runs green and the
 * blocked cases show up as skipped rather than failing. The contract itself is unchanged; the unit
 * that implements the blocking store removes the entries (and this wrapper, once none is left).
 *
 * Jest collects a `describe` block synchronously, so the case function is swapped only while
 * `describeSuite` runs and restored right after.
 */
type TestFunction = typeof it;

export function describeWithBlockedCases(
  /** The exact case titles, each with the store (and its unit) that blocks it. */
  blocked: Readonly<Record<string, string>>,
  describeSuite: () => void,
): void {
  const original = globalThis.it;
  const guarded = ((
    name: string,
    ...rest: Parameters<TestFunction> extends [unknown, ...infer R] ? R : never
  ) =>
    (blocked[name] != null ? original.skip : original)(name, ...rest)) as unknown as TestFunction;
  Object.assign(guarded, original);
  globalThis.it = guarded;
  try {
    describeSuite();
  } finally {
    globalThis.it = original;
  }
}
