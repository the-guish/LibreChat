import type { FilterQuery, Model } from 'mongoose';
import type { IConversation, IMessage, ConversationImportCleanupScope } from '~/types';
import { chunkConversationIds, createImportCleanupFilter } from './conversationImportRules';
import { runAsSystem, tenantStorage } from '~/config/tenantContext';
import { refreshChatProjectStatsForUser } from './chatProject';

export type { ConversationImportCleanupScope } from '~/types/conversationImport';
export { CONVERSATION_IMPORT_CLEANUP_CHUNK_SIZE } from './conversationImportRules';

export interface ConversationImportMethods {
  deleteImportedMessages(scope: ConversationImportCleanupScope): Promise<void>;
  deleteImportedConversations(scope: ConversationImportCleanupScope): Promise<void>;
}

export function createConversationImportMethods(
  mongoose: typeof import('mongoose'),
): ConversationImportMethods {
  async function deleteImportedMessages(scope: ConversationImportCleanupScope): Promise<void> {
    if (scope.conversationIds.length === 0) {
      return;
    }
    const Message = mongoose.models.Message as Model<IMessage>;
    await runAsSystem(async () => {
      for (const conversationIds of chunkConversationIds(scope.conversationIds)) {
        await Message.deleteMany(
          createImportCleanupFilter(scope, conversationIds) as FilterQuery<IMessage>,
        );
        await mongoose.models.SubagentContent?.deleteMany({
          user: scope.user,
          conversationId: { $in: conversationIds },
          ...(scope.tenantId == null
            ? { tenantId: { $exists: false } }
            : { tenantId: scope.tenantId }),
        });
      }
    });
  }

  async function deleteImportedConversations(scope: ConversationImportCleanupScope): Promise<void> {
    if (scope.conversationIds.length === 0) {
      return;
    }
    const Conversation = mongoose.models.Conversation as Model<IConversation>;
    const projectIds = await runAsSystem(async () => {
      const affectedProjectIds = new Set<string>();
      for (const conversationIds of chunkConversationIds(scope.conversationIds)) {
        const filter = createImportCleanupFilter(
          scope,
          conversationIds,
        ) as FilterQuery<IConversation>;
        const affectedProjects = await Conversation.distinct('chatProjectId', filter);
        for (const projectId of affectedProjects) {
          if (projectId) {
            affectedProjectIds.add(String(projectId));
          }
        }
        await Conversation.deleteMany(filter);
        await mongoose.models.SubagentContent?.deleteMany(filter);
      }
      return [...affectedProjectIds];
    });
    const context = tenantStorage.getStore();
    await tenantStorage.run(
      { ...context, tenantId: scope.tenantId, userId: scope.user },
      async () => {
        await Promise.all(
          projectIds.map((projectId) =>
            refreshChatProjectStatsForUser(mongoose, scope.user, projectId),
          ),
        );
      },
    );
  }

  return { deleteImportedMessages, deleteImportedConversations };
}
