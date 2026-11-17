/**
 * The PostgreSQL `OpenIDRefreshFlightStore` (`~/ports/openidRefreshFlight`) on the
 * `openidrefreshflights` table: the single-flight protocol of
 * `~/methods/openidRefreshFlightRules` on the collection primitive's operations. Must not import
 * `mongoose`, `mongodb` or `bson`.
 *
 * Each step is one primitive operation, so each compare-and-set (`findOneAndUpdate` with its
 * guard) is atomic as on MongoDB (§3.5). The unique `key` index comes with the migrations, so
 * nothing is ensured before the first create; a concurrent create loses on it with a duplicate
 * key, which the protocol turns into a join or a retry.
 */
import type { OpenIDRefreshFlightStore } from '~/ports/openidRefreshFlight';
import type { PostgresStoreContext } from './context';
import type { IOpenIDRefreshFlight } from '~/types';
import { createOpenIDRefreshFlightOnSteps } from '~/methods/openidRefreshFlightRules';
import { StoreDuplicateKeyError } from '~/ports/storeErrors';

type FlightRecord = IOpenIDRefreshFlight & Record<string, unknown>;

export function createPostgresOpenIDRefreshFlightStore(
  context: PostgresStoreContext,
): OpenIDRefreshFlightStore {
  const flights = () => context.collections().collection<FlightRecord>('openidrefreshflights');

  const store: OpenIDRefreshFlightStore = createOpenIDRefreshFlightOnSteps({
    awaitIndexes: async () => undefined,
    create: (record) => flights().insertOne(record),
    findOneAndUpdate: (filter, update, options = {}) =>
      flights().findOneAndUpdate(filter, update, {
        returnDocument: 'after',
        upsert: options.upsert === true,
      }),
    findOne: (filter) => flights().findOne(filter),
    findOneAndDelete: (filter) => flights().findOneAndDelete(filter),
    isDuplicateKey: (error) => error instanceof StoreDuplicateKeyError,
  });
  return store;
}
