import mongoose from 'mongoose';
import type { Assert, EveryMethodPlaced, ExclusionsHold, SameSignatures } from './conformance';
import type { BrowserSetupBackend } from '~/types/browserSetup';
import type { BrowserSetupBackendStore } from './browserSetup';
import { createCodeEnvironmentMethods } from '~/methods/codeEnvironment';
import { BROWSER_SETUP_BACKEND_STORE_METHODS } from './browserSetup';
import { createBrowserSetupBackend } from '~/methods/browserSetup';

/**
 * Browser setup backend methods left out of the port, each with the reason: none. Every
 * method's signature is already database-neutral, so the port copies them verbatim.
 */
const EXCLUDED = [] as const;
type Excluded = (typeof EXCLUDED)[number];

type BrowserSetupBackendMethods = ReturnType<typeof createBrowserSetupBackend>;

/* Type-level conformance (see `./conformance`): fails `npm run typecheck`, not Jest. */
type Checks = [
  Assert<SameSignatures<BrowserSetupBackendStore, BrowserSetupBackend>>,
  Assert<SameSignatures<BrowserSetupBackendStore, BrowserSetupBackendMethods>>,
  Assert<EveryMethodPlaced<BrowserSetupBackendStore, BrowserSetupBackendMethods, Excluded>>,
  Assert<ExclusionsHold<BrowserSetupBackendStore, Excluded>>,
];

describe('BrowserSetupBackendStore port', () => {
  const methods = createBrowserSetupBackend(mongoose);

  it('matches the MongoDB browser setup backend at the type level', () => {
    // A wrong signature, an unplaced method or a broken exclusion fails to compile here.
    const typeChecks: Checks = [true, true, true, true];
    expect(typeChecks).toEqual([true, true, true, true]);
  });

  it('lists each method once', () => {
    expect(new Set(BROWSER_SETUP_BACKEND_STORE_METHODS).size).toBe(
      BROWSER_SETUP_BACKEND_STORE_METHODS.length,
    );
  });

  it('places every runtime method in the port or the exclusion list', () => {
    expect(Object.keys(methods).sort()).toEqual(
      [...BROWSER_SETUP_BACKEND_STORE_METHODS, ...EXCLUDED].sort(),
    );
  });

  it('is satisfied by the MongoDB browser setup backend', () => {
    const store: BrowserSetupBackendStore = methods;
    for (const name of BROWSER_SETUP_BACKEND_STORE_METHODS) {
      expect(typeof store[name]).toBe('function');
    }
  });

  it('registers through the code environment methods it is given, not a second instance', () => {
    const codeEnvironments = createCodeEnvironmentMethods(mongoose);
    const backend = createBrowserSetupBackend(mongoose, codeEnvironments);
    expect(backend.ensureRegistration).toBe(codeEnvironments.ensureSetupEnvironmentIndexes);
  });
});
