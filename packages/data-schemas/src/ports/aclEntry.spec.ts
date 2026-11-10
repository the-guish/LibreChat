import mongoose from 'mongoose';
import type { Assert, EveryMethodPlaced, ExclusionsHold, Satisfies } from './conformance';
import type { AclEntryMethods } from '~/methods/aclEntry';
import type { AclEntryStore } from './aclEntry';
import { createAclEntryMethods } from '~/methods/aclEntry';
import { ACL_ENTRY_STORE_METHODS } from './aclEntry';

/**
 * ACL entry methods left out of the port, each with the reason:
 * - `findEntriesByResource`: its optional trailing parameter is a MongoDB `ClientSession`.
 * - `findEntriesByPrincipalsAndResource`: its fourth parameter is a MongoDB `ClientSession`.
 * - `grantPermission`: its seventh parameter is a MongoDB `ClientSession`.
 * - `modifyPermissionBits`: its seventh parameter is a MongoDB `ClientSession`.
 * - `deleteAclEntries`: its first parameter is a raw MongoDB filter, its options a session.
 * - `replaceRoleBits`: each write carries a raw MongoDB filter, its options a session.
 * - `bulkWriteAclEntries`: it takes MongoDB bulk-write operations and a session, and resolves to
 *   the driver's `BulkWriteResult`.
 * - `aggregateAclEntries`: it takes a MongoDB aggregation pipeline.
 *
 * The other methods' signatures are database-neutral but for ids typed `Types.ObjectId`, which
 * the port states as `IdLike`.
 */
const EXCLUDED = [
  'findEntriesByResource',
  'findEntriesByPrincipalsAndResource',
  'grantPermission',
  'modifyPermissionBits',
  'deleteAclEntries',
  'replaceRoleBits',
  'bulkWriteAclEntries',
  'aggregateAclEntries',
] as const;
type Excluded = (typeof EXCLUDED)[number];

/* Type-level conformance (see `./conformance`): fails `npm run typecheck`, not Jest. */
type Checks = [
  Assert<Satisfies<AclEntryStore, AclEntryMethods>>,
  Assert<EveryMethodPlaced<AclEntryStore, AclEntryMethods, Excluded>>,
  Assert<ExclusionsHold<AclEntryStore, Excluded>>,
];

describe('AclEntryStore port', () => {
  const methods = createAclEntryMethods(mongoose);

  it('matches the MongoDB ACL entry methods at the type level', () => {
    // A wrong signature, an unplaced method or a broken exclusion fails to compile here.
    const typeChecks: Checks = [true, true, true];
    expect(typeChecks).toEqual([true, true, true]);
  });

  it('lists each method once', () => {
    expect(new Set(ACL_ENTRY_STORE_METHODS).size).toBe(ACL_ENTRY_STORE_METHODS.length);
  });

  it('places every runtime method in the port or the exclusion list', () => {
    expect(Object.keys(methods).sort()).toEqual([...ACL_ENTRY_STORE_METHODS, ...EXCLUDED].sort());
  });

  it('is satisfied by the MongoDB ACL entry methods', () => {
    const store: AclEntryStore = methods;
    for (const name of ACL_ENTRY_STORE_METHODS) {
      expect(typeof store[name]).toBe('function');
    }
  });
});
