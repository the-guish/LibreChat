import mongoose from 'mongoose';
import type { Assert, EveryMethodPlaced, ExclusionsHold, Satisfies } from './conformance';
import type { MemoryMethods } from '~/methods/memory';
import type { MemoryStore } from './memory';
import { createMemoryMethods } from '~/methods/memory';
import { MEMORY_STORE_METHODS } from './memory';

/**
 * Memory methods left out of the port, each with the reason: none. Every method's
 * signature is database-neutral but for user ids typed `Types.ObjectId`, which the port states
 * as `IdLike`.
 */
const EXCLUDED = [] as const;
type Excluded = (typeof EXCLUDED)[number];

/* Type-level conformance (see `./conformance`): fails `npm run typecheck`, not Jest. */
type Checks = [
  Assert<Satisfies<MemoryStore, MemoryMethods>>,
  Assert<EveryMethodPlaced<MemoryStore, MemoryMethods, Excluded>>,
  Assert<ExclusionsHold<MemoryStore, Excluded>>,
];

describe('MemoryStore port', () => {
  const methods = createMemoryMethods(mongoose);

  it('matches the MongoDB memory methods at the type level', () => {
    // A wrong signature, an unplaced method or a broken exclusion fails to compile here.
    const typeChecks: Checks = [true, true, true];
    expect(typeChecks).toEqual([true, true, true]);
  });

  it('lists each method once', () => {
    expect(new Set(MEMORY_STORE_METHODS).size).toBe(MEMORY_STORE_METHODS.length);
  });

  it('places every runtime method in the port or the exclusion list', () => {
    expect(Object.keys(methods).sort()).toEqual([...MEMORY_STORE_METHODS, ...EXCLUDED].sort());
  });

  it('is satisfied by the MongoDB memory methods', () => {
    const store: MemoryStore = methods;
    for (const name of MEMORY_STORE_METHODS) {
      expect(typeof store[name]).toBe('function');
    }
  });
});
