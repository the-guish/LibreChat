/**
 * The PostgreSQL `PluginAuthStore` (`~/ports/pluginAuth`) on the `pluginauths` table, through the
 * collection primitive, with the filters of `~/methods/pluginAuthRules`. Must not import
 * `mongoose`, `mongodb` or `bson`.
 *
 * As on MongoDB: `updatePluginAuth` is one atomic upsert; without `all`, `deletePluginAuth`
 * deletes one value of the user's field whichever plugin holds it; failures are rethrown with
 * the same messages.
 */
import type { PluginAuthStore } from '~/ports/pluginAuth';
import type { PostgresStoreContext } from './context';
import type { IPluginAuth } from '~/types';
import { pluginAuthDeletion, pluginAuthFilter } from '~/methods/pluginAuthRules';

type PluginAuthRecord = IPluginAuth & Record<string, unknown>;

/** The error a failed operation rethrows, naming what failed. */
function failure(what: string, error: unknown): Error {
  return new Error(
    `Failed to ${what}: ${error instanceof Error ? error.message : 'Unknown error'}`,
  );
}

export function createPostgresPluginAuthStore(context: PostgresStoreContext): PluginAuthStore {
  const pluginAuths = () => context.collections().collection<PluginAuthRecord>('pluginauths');

  const store: PluginAuthStore = {
    async findOnePluginAuth({ userId, authField, pluginKey }) {
      try {
        return await pluginAuths().findOne(pluginAuthFilter({ userId, authField, pluginKey }));
      } catch (error) {
        throw failure('find plugin auth', error);
      }
    },

    async findPluginAuthsByKeys({ userId, pluginKeys }) {
      try {
        if (!pluginKeys || pluginKeys.length === 0) {
          return [];
        }
        return await pluginAuths().find({ userId, pluginKey: { $in: pluginKeys } });
      } catch (error) {
        throw failure('find plugin auths', error);
      }
    },

    async updatePluginAuth({ userId, authField, pluginKey, value }) {
      try {
        /** Single atomic upsert: a find-then-save let concurrent writers insert duplicates. */
        return (await pluginAuths().findOneAndUpdate(
          { userId, pluginKey, authField },
          { $set: { value } },
          { returnDocument: 'after', upsert: true },
        )) as PluginAuthRecord;
      } catch (error) {
        throw failure('update plugin auth', error);
      }
    },

    async deletePluginAuth(params) {
      try {
        const { many, filter } = pluginAuthDeletion(params);
        return many
          ? await pluginAuths().deleteMany(filter)
          : await pluginAuths().deleteOne(filter);
      } catch (error) {
        throw failure('delete plugin auth', error);
      }
    },

    async deleteAllUserPluginAuths(userId) {
      try {
        return await pluginAuths().deleteMany({ userId });
      } catch (error) {
        throw failure('delete all user plugin auths', error);
      }
    },
  };
  return store;
}
