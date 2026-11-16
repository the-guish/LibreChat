/**
 * The PostgreSQL `AssistantStore` (`~/ports/assistant`) on the `assistants` table, through the
 * collection primitive, with the criteria and avatar rules of `~/methods/assistantRules`. Must not
 * import `mongoose`, `mongodb` or `bson`.
 *
 * - `updateAssistantAvatar` follows the MongoDB method step by step: the record a missing
 *   assistant gets is inserted under the id `assistantAvatarSeedId` derives, so concurrent
 *   initializations race for one primary key (the loser re-reads the winner's record), and the
 *   avatar write is guarded by the identity it was decided on. The guard compares the whole
 *   `avatar` value, which the query language cannot (equality with an object), so that write is
 *   a lock-then-update with one hand-written `SELECT ... FOR UPDATE` (`guardedUpdate`).
 * - `ensureAssistantIndexes` resolves at once: the indexes come with the migrations.
 */
import { sql } from 'kysely';
import type { AssistantStore } from '~/ports/assistant';
import type { PostgresStoreContext } from './context';
import type { IAssistant } from '~/types';
import {
  assistantCriteria,
  isAvatarUpdateNeeded,
  assistantAvatarGuard,
  assistantAvatarSeedId,
  assistantAvatarUpdate,
  validateAssistantAvatarUpdate,
} from '~/methods/assistantRules';
import { asRecord, runStoreSql, storeWhere } from './context';
import { StoreDuplicateKeyError } from '~/ports/storeErrors';
import { encodeJsonColumn } from '../values';

type AssistantRecord = IAssistant & Record<string, unknown>;

export function createPostgresAssistantStore(context: PostgresStoreContext): AssistantStore {
  const assistants = () => context.collections().collection<AssistantRecord>('assistants');
  /**
   * `findOneAndUpdate({ _id, ...guard }, update)` returning the record after it, where `guard`
   * compares `avatar` (a `json` column) as a whole, which the query language cannot say: in one
   * transaction, the record is locked only while the guard holds (hand-written `SELECT ... FOR
   * UPDATE`, the `avatar` compared as `jsonb`, so key order is not compared), then updated by
   * `_id`. The table has no child tables.
   */
  async function guardedUpdate(
    reference: AssistantRecord,
    guard: Record<string, unknown>,
    update: Record<string, unknown>,
  ): Promise<AssistantRecord | null> {
    const { avatar: guardAvatar, ...columns } = guard;
    return context.transactions.transaction(async (tx) => {
      const where = storeWhere(
        context,
        'assistants',
        { _id: reference._id, ...columns },
        {
          operation: 'Query',
        },
      );
      const avatarCondition =
        guardAvatar == null
          ? sql`t."avatar" IS NULL`
          : sql`t."avatar"::jsonb = ${encodeJsonColumn(guardAvatar, { countNul: false })}::jsonb`;
      const { rows } = await runStoreSql(
        context,
        sql`SELECT t."_id" FROM "assistants" AS t WHERE ${where} AND ${avatarCondition} FOR UPDATE`,
        tx,
      );
      if (rows.length === 0) {
        return null;
      }
      return assistants().findOneAndUpdate({ _id: reference._id }, update, {
        returnDocument: 'after',
        tx,
      });
    });
  }

  const store: AssistantStore = {
    async getAssistant(query, projection) {
      return assistants().findOne(assistantCriteria(query), projection ? { projection } : {});
    },

    async getAssistants(query, select = null) {
      return assistants().find(assistantCriteria(query), select ? { projection: select } : {});
    },

    /** Merges `updateData` into the matching assistant, or creates it (an upsert). */
    async updateAssistantDoc(query, updateData) {
      return assistants().findOneAndUpdate(assistantCriteria(query), asRecord(updateData), {
        upsert: true,
        returnDocument: 'after',
      });
    },

    async updateAssistantAvatar(query, avatar, onInsert) {
      const insertData = validateAssistantAvatarUpdate(query, onInsert);
      const { assistantId, user } = query;
      let reference = await assistants().findOne(assistantCriteria({ assistantId }));
      if (!reference) {
        if (!insertData) {
          return null;
        }
        /** The primary key arbitrates concurrent initialization across replicas. */
        const _id = assistantAvatarSeedId(assistantId);
        try {
          return await assistants().insertOne({
            _id,
            assistant_id: assistantId,
            ...insertData,
            avatar,
          });
        } catch (error) {
          if (!(error instanceof StoreDuplicateKeyError)) {
            throw error;
          }
          reference = await assistants().findOne({ _id, assistant_id: assistantId });
          if (!reference) {
            throw error;
          }
        }
      }
      if (user !== undefined && reference.user?.toString() !== user) {
        if (!insertData) {
          return null;
        }
        if (reference.user != null) {
          throw new Error('Assistant ownership changed before the avatar update');
        }
      }

      if (!isAvatarUpdateNeeded(reference, avatar, insertData)) {
        return reference;
      }

      /** Avatar and backfill share one identity guard, so a lost race cannot partially write. */
      const updated = await guardedUpdate(
        reference,
        assistantAvatarGuard(reference, assistantId),
        assistantAvatarUpdate(reference, avatar, insertData),
      );
      if (!updated) {
        throw new Error('Assistant identity changed before the avatar update');
      }
      return Object.assign(updated, { previousAvatar: reference.avatar });
    },

    async deleteAssistant(query) {
      return assistants().findOneAndDelete(assistantCriteria(query));
    },

    async deleteAssistants(query) {
      return (await assistants().deleteMany(assistantCriteria(query))).deletedCount;
    },

    async ensureAssistantIndexes() {
      return undefined;
    },
  };
  return store;
}
