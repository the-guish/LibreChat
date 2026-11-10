import mongoose from 'mongoose';
import type { Assert, EveryMethodPlaced, ExclusionsHold, Satisfies } from './conformance';
import type { CodeEnvironmentMethods } from '~/methods/codeEnvironment';
import type { CodeEnvironmentStore } from './codeEnvironment';
import { createCodeEnvironmentMethods } from '~/methods/codeEnvironment';
import { CODE_ENVIRONMENT_STORE_METHODS } from './codeEnvironment';

/**
 * Code environment methods left out of the port, each with the reason: none. Every method's
 * signature is database-neutral but for record and user ids typed `Types.ObjectId`, which the
 * port states as `IdLike`.
 */
const EXCLUDED = [] as const;
type Excluded = (typeof EXCLUDED)[number];

/* Type-level conformance (see `./conformance`): fails `npm run typecheck`, not Jest. */
type Checks = [
  Assert<Satisfies<CodeEnvironmentStore, CodeEnvironmentMethods>>,
  Assert<EveryMethodPlaced<CodeEnvironmentStore, CodeEnvironmentMethods, Excluded>>,
  Assert<ExclusionsHold<CodeEnvironmentStore, Excluded>>,
];

describe('CodeEnvironmentStore port', () => {
  const methods = createCodeEnvironmentMethods(mongoose);

  it('matches the MongoDB code environment methods at the type level', () => {
    // A wrong signature, an unplaced method or a broken exclusion fails to compile here.
    const typeChecks: Checks = [true, true, true];
    expect(typeChecks).toEqual([true, true, true]);
  });

  it('lists each method once', () => {
    expect(new Set(CODE_ENVIRONMENT_STORE_METHODS).size).toBe(
      CODE_ENVIRONMENT_STORE_METHODS.length,
    );
  });

  it('places every runtime method in the port or the exclusion list', () => {
    expect(Object.keys(methods).sort()).toEqual(
      [...CODE_ENVIRONMENT_STORE_METHODS, ...EXCLUDED].sort(),
    );
  });

  it('is satisfied by the MongoDB code environment methods', () => {
    const store: CodeEnvironmentStore = methods;
    for (const name of CODE_ENVIRONMENT_STORE_METHODS) {
      expect(typeof store[name]).toBe('function');
    }
  });
});
