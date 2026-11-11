/**
 * Test helpers for the code environment registry, the lifecycle reconciler and the worker
 * revocation on account deletion, which take the data layer. They build the data methods in a way
 * that works whether those take a mongoose instance (`createCodeEnvironmentRegistry(mongoose)`,
 * `reconcileCodeEnvironmentLifecycle({ mongoose })`) or, as now, the data methods
 * (`createCodeEnvironmentRegistry(db)`, `reconcileCodeEnvironmentLifecycle({ db })`), so the specs
 * that use them pass on both sides of that change.
 */
import { createMethods } from '@librechat/data-schemas';
import { asDataLayer } from '~/acl/dataLayer.helper';

type Mongoose = typeof import('mongoose');
type CodeEnvironmentDataLayer = Mongoose & ReturnType<typeof createMethods>;

/**
 * The data methods built on `mongoose` (without caches, as the registry built its own before),
 * readable as that mongoose instance too, for `createCodeEnvironmentRegistry`.
 */
export function codeEnvironmentDataLayer(mongoose: Mongoose): CodeEnvironmentDataLayer {
  return asDataLayer(mongoose, createMethods(mongoose));
}

/**
 * The data layer under both option names the reconciler and the worker revocation have taken
 * (`mongoose`, `db`), to spread into their options.
 */
export function codeEnvironmentLifecycleDataLayer(mongoose: Mongoose): {
  mongoose: CodeEnvironmentDataLayer;
  db: CodeEnvironmentDataLayer;
} {
  const dataLayer = codeEnvironmentDataLayer(mongoose);
  return { mongoose: dataLayer, db: dataLayer };
}
