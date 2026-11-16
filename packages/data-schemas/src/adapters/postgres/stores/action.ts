/**
 * The PostgreSQL `ActionStore` (`~/ports/action`) on the `actions` table, through the collection
 * primitive, with the criteria and secret removal of `~/methods/actionRules`. Must not import
 * `mongoose`, `mongodb` or `bson`.
 */
import type { PostgresStoreContext } from './context';
import type { ActionStore } from '~/ports/action';
import type { IAction } from '~/types';
import { actionCriteria, removeActionSecrets } from '~/methods/actionRules';
import { asRecord } from './context';

export function createPostgresActionStore(context: PostgresStoreContext): ActionStore {
  const actions = () =>
    context.collections().collection<IAction & Record<string, unknown>>('actions');
  const store: ActionStore = {
    async getActions(query, includeSensitive = false) {
      const found = await actions().find(actionCriteria(query));
      if (!includeSensitive) {
        removeActionSecrets(found);
      }
      return found;
    },

    /** Merges `updateData` into the matching action, or creates it (an upsert). */
    async updateAction(query, updateData) {
      return actions().findOneAndUpdate(actionCriteria(query), asRecord(updateData), {
        upsert: true,
        returnDocument: 'after',
      });
    },

    async deleteAction(query) {
      return actions().findOneAndDelete(actionCriteria(query));
    },

    async deleteActions(query) {
      return (await actions().deleteMany(actionCriteria(query))).deletedCount;
    },
  };
  return store;
}
