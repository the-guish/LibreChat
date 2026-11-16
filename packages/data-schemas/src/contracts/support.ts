/**
 * Helpers shared by the port contract suites: the harness lifecycle every suite uses, and the
 * normalizations their assertions need so they compare the same values on every backend (ids
 * as canonical strings, dates as epoch milliseconds). Nothing here may import `mongoose` or the
 * MongoDB driver.
 */
import type { ContractHarness, RawRecord } from './harness';

/** Registers the harness lifecycle: set up once, reset before each case, tear down once. */
export function useContractHarness(harness: ContractHarness): void {
  beforeAll(() => harness.setup(), 120_000);
  afterAll(() => harness.teardown());
  beforeEach(() => harness.reset());
}

/** The canonical string of the id `value` names (a store id, a hex string). */
export function idOf(harness: ContractHarness, value: unknown): string {
  return harness.ids.toCanonicalString(value);
}

/** Epoch milliseconds of a date the store returned (a `Date`, or its ISO/number form). */
export function timeOf(value: unknown): number {
  if (value instanceof Date) {
    return value.getTime();
  }
  if (typeof value === 'string' || typeof value === 'number') {
    return new Date(value).getTime();
  }
  throw new Error(`Not a date: ${String(value)}`);
}

/** The raw records of `collection` that match every field of `where` (compared as given). */
export async function readRawWhere(
  harness: ContractHarness,
  collection: string,
  where: RawRecord = {},
): Promise<RawRecord[]> {
  const records = await harness.readRaw(collection);
  return records.filter((record) =>
    Object.entries(where).every(([key, value]) => Object.is(record[key], value)),
  );
}
