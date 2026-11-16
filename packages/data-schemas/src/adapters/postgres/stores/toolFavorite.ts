/**
 * The PostgreSQL `ToolFavoriteStore` (`~/ports/favorite`) on the `toolfavorites` table, through
 * the collection primitive. Must not import `mongoose`, `mongodb` or `bson`.
 *
 * As on MongoDB: an idempotent add whose cap check is read-then-write (a soft cap that racing
 * adds may overshoot by one or two), the unique `{ user, itemType, itemId }` index settling
 * racing duplicate adds (a duplicate key from the upsert counts as added), and the validators
 * run on the inserted favorite.
 */
import type { ToolFavoriteStore } from '~/ports/favorite';
import type { PostgresStoreContext } from './context';
import type { IToolFavoriteLean } from '~/types';
import { MAX_TOOL_FAVORITES, toolFavoriteCapError } from '~/methods/favoriteRules';
import { StoreDuplicateKeyError } from '~/ports/storeErrors';

export function createPostgresToolFavoriteStore(context: PostgresStoreContext): ToolFavoriteStore {
  const favorites = () => context.collections().collection('toolfavorites');
  const store: ToolFavoriteStore = {
    async getToolFavorites(userId) {
      return (await favorites().find(
        { user: userId },
        { projection: 'itemType itemId -_id', sort: { createdAt: 1 } },
      )) as unknown as IToolFavoriteLean[];
    },

    async addToolFavorite({ userId, itemType, itemId }) {
      const filter = { user: userId, itemType, itemId };
      if ((await favorites().exists(filter)) != null) {
        return { ok: true, added: false };
      }
      if ((await favorites().count({ user: userId })) >= MAX_TOOL_FAVORITES) {
        throw toolFavoriteCapError();
      }
      try {
        await favorites().updateOne(
          filter,
          { $setOnInsert: filter },
          { upsert: true, runValidators: true },
        );
      } catch (error) {
        if (!(error instanceof StoreDuplicateKeyError)) {
          throw error;
        }
      }
      return { ok: true, added: true };
    },

    async removeToolFavorite({ userId, itemType, itemId }) {
      const result = await favorites().deleteOne({ user: userId, itemType, itemId });
      return { ok: true, removed: result.deletedCount > 0 };
    },

    async deleteUserToolFavorites(userId) {
      return (await favorites().deleteMany({ user: userId })).deletedCount;
    },
  };
  return store;
}
