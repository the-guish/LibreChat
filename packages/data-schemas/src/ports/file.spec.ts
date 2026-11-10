import mongoose from 'mongoose';
import type { Assert, EveryMethodPlaced, ExclusionsHold, SameSignatures } from './conformance';
import type { FileMethods } from '~/methods/file';
import type { FileStore } from './file';
import { createFileMethods } from '~/methods/file';
import { FILE_STORE_METHODS } from './file';

/**
 * File methods left out of the port, each with the reason:
 * - `findFileById`: its options are a raw MongoDB filter merged into the by-id query.
 * - `getFiles`: takes a raw MongoDB filter (`FilterQuery<IMongoFile>`), a sort record, a
 *   projection (object or string) and a limit.
 * - `updateFile`: takes an optional raw MongoDB filter (`FilterQuery<IMongoFile>`) that makes
 *   the update conditional, and non-test callers pass one.
 * - `deleteFileByFilter`: takes a raw MongoDB filter (`FilterQuery<IMongoFile>`).
 *
 * The other methods' signatures are already database-neutral, so the port copies them
 * verbatim.
 */
const EXCLUDED = ['findFileById', 'getFiles', 'updateFile', 'deleteFileByFilter'] as const;
type Excluded = (typeof EXCLUDED)[number];

/* Type-level conformance (see `./conformance`): fails `npm run typecheck`, not Jest. */
type Checks = [
  Assert<SameSignatures<FileStore, FileMethods>>,
  Assert<EveryMethodPlaced<FileStore, FileMethods, Excluded>>,
  Assert<ExclusionsHold<FileStore, Excluded>>,
];

describe('FileStore port', () => {
  const methods = createFileMethods(mongoose);

  it('matches the MongoDB file methods at the type level', () => {
    // A wrong signature, an unplaced method or a broken exclusion fails to compile here.
    const typeChecks: Checks = [true, true, true];
    expect(typeChecks).toEqual([true, true, true]);
  });

  it('lists each method once', () => {
    expect(new Set(FILE_STORE_METHODS).size).toBe(FILE_STORE_METHODS.length);
  });

  it('places every runtime method in the port or the exclusion list', () => {
    expect(Object.keys(methods).sort()).toEqual([...FILE_STORE_METHODS, ...EXCLUDED].sort());
  });

  it('is satisfied by the MongoDB file methods', () => {
    const store: FileStore = methods;
    for (const name of FILE_STORE_METHODS) {
      expect(typeof store[name]).toBe('function');
    }
  });
});
