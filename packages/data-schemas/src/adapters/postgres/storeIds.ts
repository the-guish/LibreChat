/**
 * PostgreSQL store ids (`~/ports/storeIds`; docs/postgres-port/PHASE4.md §1.2, R7): 24 lowercase
 * hex characters, generated in Node with MongoDB's ObjectId layout, stored in `lc_object_id`
 * columns (`text COLLATE "C"`). Must not import `mongoose`, `mongodb` or `bson`.
 *
 * The 12 bytes are 4 bytes of seconds since the epoch (big-endian), 5 random bytes chosen once
 * per process, and a 3-byte counter that starts at a random value and wraps. So ids generated
 * later sort after earlier ones (by second, then by counter within one process, except across a
 * counter wrap), in code point order as `COLLATE "C"` compares them, exactly as ObjectIds sort
 * in MongoDB.
 *
 * Differences from the MongoDB ids (accepted, R7): `isValid` accepts only 24 hex characters (or
 * an object whose `toHexString()` returns them), never the 12-byte buffers (and other values the
 * driver takes) that `ObjectId.isValid` also accepts; `toStoreId` returns the canonical string
 * itself, since the store keeps ids as strings.
 */
import { randomBytes } from 'node:crypto';
import type { StoreIds } from '~/ports/storeIds';
import { isIdValue, toIdColumn } from './values';

/** The 5 random bytes of this process's ids, as 10 hex characters. */
let processUnique: string | undefined;
/** The pid `processUnique` was chosen in (a forked child chooses its own). */
let processUniquePid: number | undefined;
/** The next counter value (24 bits). */
let counter: number = randomBytes(3).readUIntBE(0, 3);

const COUNTER_MODULUS = 0x1000000;

function getProcessUnique(): string {
  if (processUnique === undefined || processUniquePid !== process.pid) {
    processUnique = randomBytes(5).toString('hex');
    processUniquePid = process.pid;
  }
  return processUnique;
}

/**
 * A new id: 8 hex characters of seconds, this process's 10 random hex characters, and 6 hex
 * characters of the counter. `nowMs` is the clock (for specs).
 */
export function generatePostgresStoreId(nowMs: number = Date.now()): string {
  const seconds = Math.floor(nowMs / 1000) % 0x100000000;
  const count = counter;
  counter = (counter + 1) % COUNTER_MODULUS;
  return (
    seconds.toString(16).padStart(8, '0') + getProcessUnique() + count.toString(16).padStart(6, '0')
  );
}

/** The time an id was generated at, to the second (its first 4 bytes). */
export function postgresStoreIdTimestamp(id: string): Date {
  return new Date(parseInt(toIdColumn(id).slice(0, 8), 16) * 1000);
}

/** PostgreSQL store ids: canonical 24 lowercase hex strings, generated in ObjectId layout. */
export const postgresStoreIds: StoreIds = {
  isValid: (value) => isIdValue(value),
  toCanonicalString: (value) => canonical(value),
  toStoreId: (value) => canonical(value),
  generate: () => generatePostgresStoreId(),
};

function canonical(value: unknown): string {
  if (!isIdValue(value)) {
    throw new TypeError(`Not a valid store id: ${String(value)}`);
  }
  return toIdColumn(value);
}
