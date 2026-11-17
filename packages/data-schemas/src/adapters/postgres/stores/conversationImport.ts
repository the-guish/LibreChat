/**
 * The PostgreSQL `ConversationImportStore` (`~/ports/conversationImport`): the cleanup of a failed
 * import, on the messages, conversations and subagent content tables, with the scope's filter and
 * chunks of `~/methods/conversationImportRules`. Must not import `mongoose`, `mongodb` or `bson`.
 *
 * As on MongoDB, the deletes run in the system tenant scope (the filter names the scope's tenant,
 * or none), the affected chat projects are read with `distinct` before their conversations go,
 * and their statistics are then refreshed in the scope's tenant and user.
 */
import type { ConversationImportStore } from '~/ports/conversationImport';
import type { PostgresStoreContext } from './context';
import { chunkConversationIds, createImportCleanupFilter } from '~/methods/conversationImportRules';
import { createChatProjectStats, conversationTables } from './conversationSupport';
import { runAsSystem, tenantStorage } from '~/config/tenantContext';

export function createPostgresConversationImportStore(
  context: PostgresStoreContext,
): ConversationImportStore {
  const collection = (name: string) => context.collections().collection(name);
  const stats = createChatProjectStats(conversationTables(context));

  const store: ConversationImportStore = {
    async deleteImportedMessages(scope) {
      if (scope.conversationIds.length === 0) {
        return;
      }
      await runAsSystem(async () => {
        for (const conversationIds of chunkConversationIds(scope.conversationIds)) {
          const filter = createImportCleanupFilter(scope, conversationIds);
          await collection('messages').deleteMany(filter);
          await collection('subagentcontents').deleteMany(filter);
        }
      });
    },

    async deleteImportedConversations(scope) {
      if (scope.conversationIds.length === 0) {
        return;
      }
      const projectIds = await runAsSystem(async () => {
        const affectedProjectIds = new Set<string>();
        for (const conversationIds of chunkConversationIds(scope.conversationIds)) {
          const filter = createImportCleanupFilter(scope, conversationIds);
          const affectedProjects = await collection('conversations').distinct(
            'chatProjectId',
            filter,
          );
          for (const projectId of affectedProjects) {
            if (projectId) {
              affectedProjectIds.add(String(projectId));
            }
          }
          await collection('conversations').deleteMany(filter);
          await collection('subagentcontents').deleteMany(filter);
        }
        return [...affectedProjectIds];
      });
      const current = tenantStorage.getStore();
      await tenantStorage.run(
        { ...current, tenantId: scope.tenantId, userId: scope.user },
        async () => {
          await Promise.all(
            projectIds.map((projectId) => stats.refreshChatProjectStats(scope.user, projectId)),
          );
        },
      );
    },
  };
  return store;
}
