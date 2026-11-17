/**
 * The PostgreSQL `ChatProjectStore` (`~/ports/chatProject`) on the `chatprojects` table, through
 * the collection primitive, with the rules of `~/methods/chatProjectRules` (input limits, the
 * listing plan and cursor, the guarded update, the file attach, the statistics refresh). It reads
 * and writes the conversations and files tables directly where its methods need them (detaching
 * a deleted project's conversations, moving a conversation, attaching a file). Must not import
 * `mongoose`, `mongodb` or `bson`.
 *
 * - `file_ids` is a `text[]` column: the attach is `$addToSet` guarded by
 *   `file_ids: { $ne }` and the capacity path `file_ids.<max - 1>` not existing, the detach
 *   `$pull`, both with `$inc: { contextRevision: 1 }`.
 * - The listing is the primitive's `find` with the plan's filter, `{ [sortBy]: order, _id: order }`
 *   and `limit + 1`; the fields MongoDB's `$project` computes (`hasInstructions`, `fileCount`)
 *   are computed from the read record, which keeps the same keys (absent fields stay absent).
 * - A project id that is not 24 hex characters reads as absent; ids come back as hex strings.
 */
import type { ChatProjectStore } from '~/ports/chatProject';
import type { IChatProject, IConversation } from '~/types';
import type { PostgresStoreContext } from './context';
import type { PgRecord } from '../collection';
import {
  planChatProjectList,
  sanitizeProjectInput,
  updateChatProjectWith,
  addChatProjectFileWith,
  encodeChatProjectCursor,
} from '~/methods/chatProjectRules';
import { createChatProjectStats, conversationTables } from './conversationSupport';
import { isValidObjectIdString } from '~/utils/objectId';

type ProjectRow = IChatProject & PgRecord;

/** The fields a listed project keeps (MongoDB's `$project`), in that order. */
const LISTED_FIELDS = [
  '_id',
  'name',
  'description',
  'user',
  'tenantId',
  'conversationCount',
  'lastConversationAt',
  'lastConversationId',
  'createdAt',
  'updatedAt',
  'contextRevision',
] as const;

/** A project as the listing hands it out: the kept fields plus the two computed ones. */
function toListedProject(project: ProjectRow): IChatProject {
  const listed: Record<string, unknown> = {};
  for (const field of LISTED_FIELDS) {
    if (project[field] !== undefined) {
      listed[field] = project[field];
    }
  }
  const instructions = project.instructions ?? '';
  listed.hasInstructions = instructions !== '';
  listed.fileCount = Array.isArray(project.file_ids) ? project.file_ids.length : 0;
  return listed as unknown as IChatProject;
}

export function createPostgresChatProjectStore(context: PostgresStoreContext): ChatProjectStore {
  const projects = () => context.collections().collection<ProjectRow>('chatprojects');
  const conversations = () =>
    context.collections().collection<IConversation & PgRecord>('conversations');
  const files = () => context.collections().collection('files');
  const stats = createChatProjectStats(conversationTables(context));

  const ownerFilter = (user: string, projectId: string) => ({
    _id: projectId.toLowerCase(),
    user,
  });

  async function getChatProject(user: string, projectId: string): Promise<IChatProject | null> {
    if (!isValidObjectIdString(projectId)) {
      return null;
    }
    return projects().findOne(ownerFilter(user, projectId));
  }

  const store: ChatProjectStore = {
    async createChatProject(user, input, limits) {
      const sanitized = sanitizeProjectInput(input, limits);
      if (!sanitized.name) {
        throw new Error('Project name is required');
      }
      return projects().insertOne({
        ...sanitized,
        user,
        conversationCount: 0,
        lastConversationAt: null,
        lastConversationId: null,
      });
    },

    getChatProject,

    async listChatProjects(user, options = {}) {
      const { filter, sortBy, sortDirection, limit } = planChatProjectList(user, options, (id) =>
        id.toLowerCase(),
      );
      const order = sortDirection === 'asc' ? 1 : -1;
      const found = await projects().find(filter, {
        sort: { [sortBy]: order, _id: order },
        limit: limit + 1,
      });
      const listed = found.map(toListedProject);

      let nextCursor: string | null = null;
      if (listed.length > limit) {
        listed.pop();
        const lastProject = listed[listed.length - 1];
        if (lastProject) {
          nextCursor = encodeChatProjectCursor(lastProject, sortBy);
        }
      }
      return { projects: listed, nextCursor };
    },

    async updateChatProject(user, projectId, input, limits) {
      if (!isValidObjectIdString(projectId)) {
        return null;
      }
      return updateChatProjectWith(
        {
          writeProject: (condition, update) =>
            projects().findOneAndUpdate({ ...ownerFilter(user, projectId), ...condition }, update, {
              returnDocument: 'after',
              runValidators: true,
            }),
          getProject: () => getChatProject(user, projectId),
        },
        input,
        limits,
      );
    },

    async deleteChatProject(user, projectId) {
      if (!isValidObjectIdString(projectId)) {
        return { deletedCount: 0, modifiedCount: 0 };
      }
      const projectFilter = ownerFilter(user, projectId);
      const project = await projects().findOne(projectFilter, { projection: '_id' });
      if (!project) {
        return { deletedCount: 0, modifiedCount: 0 };
      }
      const conversationResult = await conversations().updateMany(
        { user, chatProjectId: projectId },
        { $unset: { chatProjectId: '' } },
      );
      const deleteResult = await projects().deleteOne(projectFilter);
      return {
        deletedCount: deleteResult.deletedCount ?? 0,
        modifiedCount: conversationResult.modifiedCount ?? 0,
      };
    },

    async deleteUserChatProjects(user) {
      return (await projects().deleteMany({ user })).deletedCount ?? 0;
    },

    async addChatProjectFile(user, projectId, fileId, limits) {
      return addChatProjectFileWith(
        {
          getProject: () => getChatProject(user, projectId),
          findFile: async (filter) =>
            (await files().findOne(filter, {
              projection: '_id file_id expiresAt temp_file_id',
            })) as { _id: unknown; expiresAt?: Date | null; temp_file_id?: string | null } | null,
          updateFile: (filter, update) => files().updateOne(filter, update, { timestamps: false }),
          fileExists: async (filter) => (await files().exists(filter)) != null,
          updateProject: (filter, update) => projects().updateOne(filter, update),
          attachToProject: (filter, update) =>
            projects().findOneAndUpdate(filter, update, {
              returnDocument: 'after',
              runValidators: true,
            }),
        },
        user,
        fileId,
        limits,
      );
    },

    async removeChatProjectFile(user, projectId, fileId) {
      if (!isValidObjectIdString(projectId)) {
        return null;
      }
      const project = await projects().findOneAndUpdate(
        { ...ownerFilter(user, projectId), file_ids: fileId },
        { $pull: { file_ids: fileId }, $inc: { contextRevision: 1 } },
        { returnDocument: 'after' },
      );
      return project ?? getChatProject(user, projectId);
    },

    async assignConversationToProject(user, conversationId, projectId) {
      const conversation = await conversations().findOne({ user, conversationId });
      if (!conversation) {
        return null;
      }

      const normalizedProjectId = projectId || null;
      if (normalizedProjectId) {
        if (!isValidObjectIdString(normalizedProjectId)) {
          throw new Error('Project not found');
        }
        const project = await projects().findOne(ownerFilter(user, normalizedProjectId), {
          projection: '_id',
        });
        if (!project) {
          throw new Error('Project not found');
        }
      }

      const previousProjectId = conversation.chatProjectId ?? null;
      const update =
        normalizedProjectId == null
          ? { $unset: { chatProjectId: '' } }
          : { $set: { chatProjectId: normalizedProjectId } };
      const updatedConversation = await conversations().findOneAndUpdate(
        { user, conversationId },
        update,
        { returnDocument: 'after' },
      );
      if (!updatedConversation) {
        return null;
      }

      const projectIds = new Set(
        [previousProjectId, normalizedProjectId].filter((id): id is string => Boolean(id)),
      );
      await Promise.all([...projectIds].map((id) => stats.refreshChatProjectStats(user, id)));

      return {
        conversation: updatedConversation,
        previousProjectId,
        projectId: normalizedProjectId,
      };
    },
  };
  return store;
}
