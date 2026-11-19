import mongoose from 'mongoose';
import type { Assert, EveryMethodPlaced, ExclusionsHold, Satisfies } from './conformance';
import type { AuditLogMethods } from '~/methods/auditLog';
import type { AuditLogStore } from './auditLog';
import { createAuditLogMethods } from '~/methods/auditLog';
import { AUDIT_LOG_STORE_METHODS } from './auditLog';

/**
 * Audit log methods left out of the port, each with the reason: none. Every method's signature
 * is database-neutral but for the actor and target ids of a new entry, typed `Types.ObjectId`,
 * which the port states as `IdLike`.
 */
const EXCLUDED = [] as const;
type Excluded = (typeof EXCLUDED)[number];

/* Type-level conformance (see `./conformance`): fails `npm run typecheck`, not Jest. */
type Checks = [
  Assert<Satisfies<AuditLogStore, AuditLogMethods>>,
  Assert<EveryMethodPlaced<AuditLogStore, AuditLogMethods, Excluded>>,
  Assert<ExclusionsHold<AuditLogStore, Excluded>>,
];

describe('AuditLogStore port', () => {
  const methods = createAuditLogMethods(mongoose);

  it('matches the MongoDB audit log methods at the type level', () => {
    // A wrong signature, an unplaced method or a broken exclusion fails to compile here.
    const typeChecks: Checks = [true, true, true];
    expect(typeChecks).toEqual([true, true, true]);
  });

  it('lists each method once', () => {
    expect(new Set(AUDIT_LOG_STORE_METHODS).size).toBe(AUDIT_LOG_STORE_METHODS.length);
  });

  it('places every runtime method in the port or the exclusion list', () => {
    expect(Object.keys(methods).sort()).toEqual([...AUDIT_LOG_STORE_METHODS, ...EXCLUDED].sort());
  });

  it('is satisfied by the MongoDB audit log methods', () => {
    const store: AuditLogStore = methods;
    for (const name of AUDIT_LOG_STORE_METHODS) {
      expect(typeof store[name]).toBe('function');
    }
  });
});
