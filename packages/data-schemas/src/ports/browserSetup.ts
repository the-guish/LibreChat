/**
 * Browser setup store port: what the code environment browser setup flow (the machine-facing
 * enrollment routes) needs from the database. Nothing here may import `mongoose`.
 *
 * The port is `BrowserSetupBackend` (`~/types/browserSetup`), the database-neutral contract the
 * setup router already programs against; `createBrowserSetupBackend` (`~/methods/browserSetup`)
 * returns exactly that type, and `browserSetup.spec.ts` fails the typecheck if the two drift.
 *
 * - `createStore` builds the setup session store (`BrowserSetupStore`: attempts, nonces, request
 *   and allocation budgets, leases). It is called once the database is connected, not when the
 *   backend is built; the MongoDB store creates its indexes and budget singletons on first use.
 * - `ensureRegistration` makes sure the code environment setup indexes exist before a setup
 *   reserves or completes an environment; with MongoDB it is the code environment store's own
 *   `ensureSetupEnvironmentIndexes`, built once, so both share one index-build cache.
 * - `getUser` reads the few fields of a user the setup policy checks, ids as strings.
 * - `isConnected` reports whether the database is reachable, so the reconciliation sweep can
 *   skip a tick while it is not.
 *
 * The MongoDB adapter keeps its sessions and budgets in raw collections
 * (`browser_setup_sessions`, `browser_setup_budget`, `browser_setup_requests`) and reads the user
 * collection for `getUser`.
 */
import type { BrowserSetupBackend } from '~/types/browserSetup';
import { listPortMethods } from './common';

export type BrowserSetupBackendStore = BrowserSetupBackend;

/** Every method of {@link BrowserSetupBackendStore}, for adapters and conformance checks. */
export const BROWSER_SETUP_BACKEND_STORE_METHODS: ReadonlyArray<keyof BrowserSetupBackendStore> =
  listPortMethods<BrowserSetupBackendStore>({
    createStore: true,
    ensureRegistration: true,
    getUser: true,
    isConnected: true,
  });
