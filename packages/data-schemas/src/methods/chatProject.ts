import type { FilterQuery, Model, SortOrder, Types } from 'mongoose';
import type {
  IMongoFile,
  IChatProject,
  IConversation,
  ChatProjectLimits,
  IChatProjectDocument,
  CreateChatProjectInput,
  UpdateChatProjectInput,
  ListChatProjectsResult,
  ListChatProjectsOptions,
  DeleteChatProjectResult,
  AssignConversationToProjectResult,
} from '~/types';
import type { ProjectStatsSnapshot } from './chatProjectRules';
import {
  planChatProjectList,
  sanitizeProjectInput,
  updateChatProjectWith,
  addChatProjectFileWith,
  encodeChatProjectCursor,
  refreshChatProjectStatsWith,
  updateChatProjectLastConversationWith,
} from './chatProjectRules';
import { isValidObjectIdString } from '~/utils/objectId';

export type {
  ChatProjectSortBy,
  ChatProjectLimits,
  CreateChatProjectInput,
  UpdateChatProjectInput,
  ListChatProjectsResult,
  ListChatProjectsOptions,
  DeleteChatProjectResult,
  ChatProjectSortDirection,
  AssignConversationToProjectResult,
} from '~/types/chatProject';
export { CHAT_PROJECT_CONFLICT } from './chatProjectRules';

export interface ChatProjectMethods {
  createChatProject(
    user: string,
    input: CreateChatProjectInput,
    limits?: Partial<ChatProjectLimits>,
  ): Promise<IChatProject>;
  getChatProject(user: string, projectId: string): Promise<IChatProject | null>;
  listChatProjects(
    user: string,
    options?: ListChatProjectsOptions,
  ): Promise<ListChatProjectsResult>;
  updateChatProject(
    user: string,
    projectId: string,
    input: UpdateChatProjectInput,
    limits?: Partial<ChatProjectLimits>,
  ): Promise<IChatProject | null>;
  deleteChatProject(user: string, projectId: string): Promise<DeleteChatProjectResult>;
  deleteUserChatProjects(user: string): Promise<number>;
  addChatProjectFile(
    user: string,
    projectId: string,
    fileId: string,
    limits?: Partial<ChatProjectLimits>,
  ): Promise<IChatProject | null>;
  removeChatProjectFile(
    user: string,
    projectId: string,
    fileId: string,
  ): Promise<IChatProject | null>;
  assignConversationToProject(
    user: string,
    conversationId: string,
    projectId: string | null,
  ): Promise<AssignConversationToProjectResult | null>;
}

type ProjectLean = IChatProject & { _id: Types.ObjectId };

export async function refreshChatProjectStatsForUser(
  mongoose: typeof import('mongoose'),
  user: string,
  projectId: string,
): Promise<IChatProject | null> {
  if (!isValidObjectIdString(projectId)) {
    return null;
  }

  const ChatProject = mongoose.models.ChatProject as Model<IChatProjectDocument>;
  const Conversation = mongoose.models.Conversation as Model<IConversation>;
  const projectFilter = { _id: new mongoose.Types.ObjectId(projectId), user };

  return refreshChatProjectStatsWith<IChatProject>(
    {
      readSnapshot: () =>
        ChatProject.findOne(projectFilter)
          .select('conversationCount lastConversationAt lastConversationId')
          .lean<ProjectStatsSnapshot>(),
      countConversations: (filter) =>
        Conversation.countDocuments(filter as FilterQuery<IConversation>),
      latestConversation: (filter) =>
        Conversation.findOne(filter as FilterQuery<IConversation>)
          .select('conversationId updatedAt createdAt')
          .sort({ updatedAt: -1, _id: -1 })
          .lean<IConversation>(),
      writeIfUnchanged: (snapshotFilter, set) =>
        ChatProject.findOneAndUpdate(
          { ...projectFilter, ...snapshotFilter },
          { $set: set },
          { new: true },
        ).lean<IChatProject>(),
    },
    user,
    projectId,
  );
}

export async function updateChatProjectLastConversationForUser(
  mongoose: typeof import('mongoose'),
  user: string,
  projectId: string,
  conversation: Pick<IConversation, 'conversationId' | 'createdAt' | 'updatedAt'>,
  incrementCount = false,
): Promise<void> {
  if (!isValidObjectIdString(projectId) || !conversation.conversationId) {
    return;
  }

  const ChatProject = mongoose.models.ChatProject as Model<IChatProjectDocument>;
  const Conversation = mongoose.models.Conversation as Model<IConversation>;
  const projectFilter = { _id: new mongoose.Types.ObjectId(projectId), user };
  await updateChatProjectLastConversationWith(
    {
      updateProject: (condition, update) =>
        ChatProject.updateOne({ ...projectFilter, ...condition }, update),
      conversationExists: async (filter) =>
        (await Conversation.exists(filter as FilterQuery<IConversation>)) != null,
      refresh: () => refreshChatProjectStatsForUser(mongoose, user, projectId),
    },
    user,
    projectId,
    conversation,
    incrementCount,
  );
}

export function createChatProjectMethods(mongoose: typeof import('mongoose')): ChatProjectMethods {
  async function createChatProject(
    user: string,
    input: CreateChatProjectInput,
    limits?: Partial<ChatProjectLimits>,
  ): Promise<IChatProject> {
    const ChatProject = mongoose.models.ChatProject as Model<IChatProjectDocument>;
    const sanitized = sanitizeProjectInput(input, limits);
    if (!sanitized.name) {
      throw new Error('Project name is required');
    }

    const project = await ChatProject.create({
      ...sanitized,
      user,
      conversationCount: 0,
      lastConversationAt: null,
      lastConversationId: null,
    });
    return project.toObject() as IChatProject;
  }

  async function getChatProject(user: string, projectId: string): Promise<IChatProject | null> {
    if (!isValidObjectIdString(projectId)) {
      return null;
    }

    const ChatProject = mongoose.models.ChatProject as Model<IChatProjectDocument>;
    return await ChatProject.findOne({
      _id: new mongoose.Types.ObjectId(projectId),
      user,
    }).lean<IChatProject>();
  }

  async function listChatProjects(
    user: string,
    options: ListChatProjectsOptions = {},
  ): Promise<ListChatProjectsResult> {
    const ChatProject = mongoose.models.ChatProject as Model<IChatProjectDocument>;
    const { filter, sortBy, sortDirection, limit } = planChatProjectList(
      user,
      options,
      (id) => new mongoose.Types.ObjectId(id),
    );
    const sortOrder: SortOrder = sortDirection === 'asc' ? 1 : -1;
    const query = filter as FilterQuery<IChatProjectDocument>;
    const projects = await ChatProject.aggregate<ProjectLean>([
      { $match: query },
      { $sort: { [sortBy]: sortOrder, _id: sortOrder } },
      { $limit: limit + 1 },
      {
        $project: {
          name: 1,
          description: 1,
          user: 1,
          tenantId: 1,
          conversationCount: 1,
          lastConversationAt: 1,
          lastConversationId: 1,
          createdAt: 1,
          updatedAt: 1,
          contextRevision: 1,
          hasInstructions: { $ne: [{ $ifNull: ['$instructions', ''] }, ''] },
          fileCount: { $size: { $ifNull: ['$file_ids', []] } },
        },
      },
    ]);

    let nextCursor: string | null = null;
    if (projects.length > limit) {
      projects.pop();
      const lastProject = projects[projects.length - 1];
      if (lastProject) {
        nextCursor = encodeChatProjectCursor(lastProject, sortBy);
      }
    }

    return { projects, nextCursor };
  }

  async function updateChatProject(
    user: string,
    projectId: string,
    input: UpdateChatProjectInput,
    limits?: Partial<ChatProjectLimits>,
  ): Promise<IChatProject | null> {
    if (!isValidObjectIdString(projectId)) {
      return null;
    }

    const ChatProject = mongoose.models.ChatProject as Model<IChatProjectDocument>;
    const ownerFilter = { _id: new mongoose.Types.ObjectId(projectId), user };
    return updateChatProjectWith(
      {
        writeProject: (condition, update) =>
          ChatProject.findOneAndUpdate({ ...ownerFilter, ...condition }, update, {
            new: true,
            runValidators: true,
          }).lean<IChatProject>(),
        getProject: () => getChatProject(user, projectId),
      },
      input,
      limits,
    );
  }

  async function addChatProjectFile(
    user: string,
    projectId: string,
    fileId: string,
    limits?: Partial<ChatProjectLimits>,
  ): Promise<IChatProject | null> {
    const File = mongoose.models.File as Model<IMongoFile>;
    const ChatProject = mongoose.models.ChatProject as Model<IChatProjectDocument>;
    return addChatProjectFileWith(
      {
        getProject: () => getChatProject(user, projectId),
        findFile: (filter) =>
          File.findOne(filter as FilterQuery<IMongoFile>)
            .select('_id file_id expiresAt temp_file_id')
            .lean(),
        updateFile: (filter, update) =>
          File.updateOne(filter as FilterQuery<IMongoFile>, update, { timestamps: false }),
        fileExists: async (filter) =>
          (await File.exists(filter as FilterQuery<IMongoFile>)) != null,
        updateProject: (filter, update) =>
          ChatProject.updateOne(filter as FilterQuery<IChatProjectDocument>, update),
        attachToProject: (filter, update) =>
          ChatProject.findOneAndUpdate(filter as FilterQuery<IChatProjectDocument>, update, {
            new: true,
            runValidators: true,
          }).lean<IChatProject>(),
      },
      user,
      fileId,
      limits,
    );
  }

  async function removeChatProjectFile(
    user: string,
    projectId: string,
    fileId: string,
  ): Promise<IChatProject | null> {
    if (!isValidObjectIdString(projectId)) {
      return null;
    }
    const ChatProject = mongoose.models.ChatProject as Model<IChatProjectDocument>;
    const project = await ChatProject.findOneAndUpdate(
      { _id: new mongoose.Types.ObjectId(projectId), user, file_ids: fileId },
      { $pull: { file_ids: fileId }, $inc: { contextRevision: 1 } },
      { new: true },
    ).lean<IChatProject>();
    return project ?? getChatProject(user, projectId);
  }

  async function deleteChatProject(
    user: string,
    projectId: string,
  ): Promise<DeleteChatProjectResult> {
    if (!isValidObjectIdString(projectId)) {
      return { deletedCount: 0, modifiedCount: 0 };
    }

    const ChatProject = mongoose.models.ChatProject as Model<IChatProjectDocument>;
    const Conversation = mongoose.models.Conversation as Model<IConversation>;
    const projectFilter = { _id: new mongoose.Types.ObjectId(projectId), user };
    const project = await ChatProject.findOne(projectFilter).select('_id').lean<IChatProject>();
    if (!project) {
      return { deletedCount: 0, modifiedCount: 0 };
    }

    const conversationResult = await Conversation.updateMany(
      { user, chatProjectId: projectId },
      { $unset: { chatProjectId: '' } },
    );
    const deleteResult = await ChatProject.deleteOne(projectFilter);

    return {
      deletedCount: deleteResult.deletedCount ?? 0,
      modifiedCount: conversationResult.modifiedCount ?? 0,
    };
  }

  /** Account erasure: the user's conversations are deleted first, so no chat keeps a pointer. */
  async function deleteUserChatProjects(user: string): Promise<number> {
    const ChatProject = mongoose.models.ChatProject as Model<IChatProjectDocument>;
    const result = await ChatProject.deleteMany({ user });
    return result.deletedCount ?? 0;
  }

  async function assignConversationToProject(
    user: string,
    conversationId: string,
    projectId: string | null,
  ): Promise<AssignConversationToProjectResult | null> {
    const ChatProject = mongoose.models.ChatProject as Model<IChatProjectDocument>;
    const Conversation = mongoose.models.Conversation as Model<IConversation>;
    const conversation = await Conversation.findOne({ user, conversationId }).lean<IConversation>();
    if (!conversation) {
      return null;
    }

    const normalizedProjectId = projectId || null;
    if (normalizedProjectId) {
      if (!isValidObjectIdString(normalizedProjectId)) {
        throw new Error('Project not found');
      }
      const project = await ChatProject.findOne({
        _id: new mongoose.Types.ObjectId(normalizedProjectId),
        user,
      })
        .select('_id')
        .lean<IChatProject>();
      if (!project) {
        throw new Error('Project not found');
      }
    }

    const previousProjectId = conversation.chatProjectId ?? null;
    const update =
      normalizedProjectId == null
        ? { $unset: { chatProjectId: '' } }
        : { $set: { chatProjectId: normalizedProjectId } };
    const updatedConversation = await Conversation.findOneAndUpdate(
      { user, conversationId },
      update,
      { new: true },
    ).lean<IConversation>();

    if (!updatedConversation) {
      return null;
    }

    const projectIds = new Set(
      [previousProjectId, normalizedProjectId].filter((id): id is string => Boolean(id)),
    );
    await Promise.all(
      [...projectIds].map((id) => refreshChatProjectStatsForUser(mongoose, user, id)),
    );

    return {
      conversation: updatedConversation,
      previousProjectId,
      projectId: normalizedProjectId,
    };
  }

  return {
    createChatProject,
    getChatProject,
    listChatProjects,
    updateChatProject,
    deleteChatProject,
    deleteUserChatProjects,
    addChatProjectFile,
    removeChatProjectFile,
    assignConversationToProject,
  };
}
