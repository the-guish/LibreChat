/**
 * The PostgreSQL `ConversationTagStore` (`~/ports/conversationTag`) on the `conversationtags`
 * table, through the collection primitive, with the conversations' `tags` (a `text[]` column)
 * written in the same calls as on MongoDB. Must not import `mongoose`, `mongodb` or `bson`.
 *
 * - The rename is the positional `tags.$` update on the string array (C2's tier 1 replaces the
 *   first element equal to the old name, as MongoDB does), and the removal `$pullAll`.
 * - The position shift and the count writes are the rules of `~/methods/conversationTagRules`;
 *   the count writes are one ordered `bulk` each (MongoDB's one `tenantSafeBulkWrite`); the
 *   primitive scopes their filters and upserts to the active tenant and strips `tenantId` from
 *   updates, as the wrapper does.
 * - Failures are logged and thrown with the operation's message, as on MongoDB, except in
 *   `bulkIncrementTagCounts`, which logs them.
 */
import type { ConversationTagStore } from '~/ports/conversationTag';
import type { PostgresStoreContext } from './context';
import type { ConversationTagRecord } from '~/types';
import type { PgRecord } from '../collection';
import { tagCountChanges, tagPositionShift } from '~/methods/conversationTagRules';
import logger from '~/config/winston';

type TagRow = ConversationTagRecord & PgRecord;

export function createPostgresConversationTagStore(
  context: PostgresStoreContext,
): ConversationTagStore {
  const tags = () => context.collections().collection<TagRow>('conversationtags');
  const conversations = () => context.collections().collection('conversations');

  const store: ConversationTagStore = {
    async getConversationTags(user) {
      try {
        return await tags().find({ user }, { sort: { position: 1 } });
      } catch (error) {
        logger.error('[getConversationTags] Error getting conversation tags', error);
        throw new Error('Error getting conversation tags');
      }
    },

    async createConversationTag(user, data) {
      try {
        const { tag, description, addToConversation, conversationId } = data;
        const existingTag = await tags().findOne({ user, tag });
        if (existingTag) {
          return existingTag;
        }

        const maxPosition = await tags().findOne({ user }, { sort: { position: -1 } });
        const position = ((maxPosition?.position as number | undefined) || 0) + 1;

        const newTag = await tags().findOneAndUpdate(
          { tag, user },
          {
            tag,
            user,
            count: addToConversation ? 1 : 0,
            position,
            ...(description !== undefined && { description }),
            $setOnInsert: { createdAt: new Date() },
          },
          { upsert: true, returnDocument: 'after' },
        );

        if (addToConversation && conversationId) {
          await conversations().updateOne({ user, conversationId }, { $addToSet: { tags: tag } });
        }
        return newTag;
      } catch (error) {
        logger.error('[createConversationTag] Error creating conversation tag', error);
        throw new Error('Error creating conversation tag');
      }
    },

    async updateConversationTag(user, oldTag, data) {
      try {
        const { tag: newTag, description, position } = data;
        const existingTag = await tags().findOne({ user, tag: oldTag });
        if (!existingTag) {
          return null;
        }

        if (newTag && newTag !== oldTag) {
          if (await tags().findOne({ user, tag: newTag })) {
            throw new Error('Tag already exists');
          }
          await conversations().updateMany({ user, tags: oldTag }, { $set: { 'tags.$': newTag } });
        }

        const updateData: Record<string, unknown> = {};
        if (newTag) {
          updateData.tag = newTag;
        }
        if (description !== undefined) {
          updateData.description = description;
        }
        if (position !== undefined) {
          const shift = tagPositionShift(user, existingTag.position as number, position);
          if (shift) {
            await tags().updateMany(shift.filter, shift.update);
          }
          updateData.position = position;
        }

        return await tags().findOneAndUpdate({ user, tag: oldTag }, updateData, {
          returnDocument: 'after',
        });
      } catch (error) {
        logger.error('[updateConversationTag] Error updating conversation tag', error);
        throw new Error('Error updating conversation tag');
      }
    },

    async deleteConversationTag(user, tag) {
      try {
        const deletedTag = await tags().findOneAndDelete({ user, tag });
        if (!deletedTag) {
          return null;
        }
        await conversations().updateMany({ user, tags: tag }, { $pullAll: { tags: [tag] } });
        await tags().updateMany(
          { user, position: { $gt: deletedTag.position } },
          { $inc: { position: -1 } },
        );
        return deletedTag;
      } catch (error) {
        logger.error('[deleteConversationTag] Error deleting conversation tag', error);
        throw new Error('Error deleting conversation tag');
      }
    },

    async deleteConversationTags(filter) {
      try {
        return (await tags().deleteMany(filter)).deletedCount;
      } catch (error) {
        logger.error('[deleteConversationTags] Error deleting conversation tags', error);
        throw new Error('Error deleting conversation tags');
      }
    },

    async bulkIncrementTagCounts(user, names) {
      if (!names || names.length === 0) {
        return;
      }
      try {
        const uniqueTags = [...new Set(names.filter(Boolean))];
        if (uniqueTags.length === 0) {
          return;
        }
        const result = await tags().bulk(
          uniqueTags.map((tag) => ({
            updateOne: { filter: { user, tag }, update: { $inc: { count: 1 } } },
          })),
        );
        if (result.modifiedCount > 0) {
          logger.debug(
            `user: ${user} | Incremented tag counts - modified ${result.modifiedCount} tags`,
          );
        }
      } catch (error) {
        logger.error('[bulkIncrementTagCounts] Error incrementing tag counts', error);
      }
    },

    async updateTagsForConversation(user, conversationId, names) {
      try {
        const conversation = await conversations().findOne(
          { user, conversationId },
          { projection: 'tags' },
        );
        if (!conversation) {
          throw new Error('Conversation not found');
        }

        const oldTags = new Set<string>((conversation.tags as string[] | undefined) ?? []);
        const newTags = new Set(names);
        const operations = tagCountChanges(user, oldTags, newTags);
        if (operations.length > 0) {
          await tags().bulk(operations);
        }

        const updated = await conversations().findOneAndUpdate(
          { user, conversationId },
          { $set: { tags: [...newTags] } },
          { returnDocument: 'after', projection: { tags: 1 } },
        );
        return (updated as { tags: string[] }).tags;
      } catch (error) {
        logger.error('[updateTagsForConversation] Error updating tags', error);
        throw new Error('Error updating tags for conversation');
      }
    },
  };
  return store;
}
