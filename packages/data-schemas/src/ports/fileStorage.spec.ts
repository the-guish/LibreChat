import mongoose from 'mongoose';
import type { Assert, EveryMethodPlaced, ExclusionsHold, SameSignatures } from './conformance';
import type { FileStorageMethods } from '~/methods/fileStorage';
import type { FileStorageStore } from './fileStorage';
import { createFileStorageMethods } from '~/methods/fileStorage';
import { FILE_STORAGE_STORE_METHODS } from './fileStorage';

/**
 * File storage methods left out of the port, each with the reason: none. Every method's
 * signature is already database-neutral, so the port copies them verbatim.
 */
const EXCLUDED = [] as const;
type Excluded = (typeof EXCLUDED)[number];

/* Type-level conformance (see `./conformance`): fails `npm run typecheck`, not Jest. */
type Checks = [
  Assert<SameSignatures<FileStorageStore, FileStorageMethods>>,
  Assert<EveryMethodPlaced<FileStorageStore, FileStorageMethods, Excluded>>,
  Assert<ExclusionsHold<FileStorageStore, Excluded>>,
];

describe('FileStorageStore port', () => {
  const methods = createFileStorageMethods(mongoose);

  it('matches the MongoDB file storage methods at the type level', () => {
    // A wrong signature, an unplaced method or a broken exclusion fails to compile here.
    const typeChecks: Checks = [true, true, true];
    expect(typeChecks).toEqual([true, true, true]);
  });

  it('lists each method once', () => {
    expect(new Set(FILE_STORAGE_STORE_METHODS).size).toBe(FILE_STORAGE_STORE_METHODS.length);
  });

  it('places every runtime method in the port or the exclusion list', () => {
    expect(Object.keys(methods).sort()).toEqual(
      [...FILE_STORAGE_STORE_METHODS, ...EXCLUDED].sort(),
    );
  });

  it('is satisfied by the MongoDB file storage methods', () => {
    const store: FileStorageStore = methods;
    for (const name of FILE_STORAGE_STORE_METHODS) {
      expect(typeof store[name]).toBe('function');
    }
  });
});
