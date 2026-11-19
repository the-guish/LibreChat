/**
 * Chat project store port: the projects a user groups conversations under, each with its own
 * instructions and attached files, and the assignment of conversations to them. Nothing here
 * may import `mongoose`. Signatures are copied verbatim from `ChatProjectMethods`
 * (`~/methods/chatProject`); `chatProject.spec.ts` fails the typecheck if the two drift.
 *
 * Every read and write is scoped to the user: another user's project reads as absent. A project
 * id that is not one the store generated reads as absent too. `contextRevision` counts changes
 * to what a project adds to a conversation's context (instructions, files); an update that
 * names the revision it expects throws `Project revision conflict` when the project has moved
 * on. Limits left out fall back to the deployment defaults.
 *
 * Known leaks kept for now so callers stay unchanged: `IChatProject` and `IConversation` carry
 * the records' ObjectIds (`_id`), and `IConversation` extends mongoose's `Document`.
 */
import type {
  IChatProject,
  ChatProjectLimits,
  CreateChatProjectInput,
  UpdateChatProjectInput,
  ListChatProjectsResult,
  ListChatProjectsOptions,
  DeleteChatProjectResult,
  AssignConversationToProjectResult,
} from '~/types';
import { listPortMethods } from './common';

export interface ChatProjectStore {
  /** Creates the user's project with no conversations; throws when the name is empty. */
  createChatProject(
    user: string,
    input: CreateChatProjectInput,
    limits?: Partial<ChatProjectLimits>,
  ): Promise<IChatProject>;
  /** The user's project, or `null`. */
  getChatProject(user: string, projectId: string): Promise<IChatProject | null>;
  /**
   * A page of the user's projects (25 by default, at most 100), sorted by `sortBy` (by default
   * the latest conversation, newest first), optionally only those whose name or description
   * contains `search`; `nextCursor` reads the next page and is `null` on the last one. Listed
   * projects carry `hasInstructions` and `fileCount` instead of their instructions and files.
   */
  listChatProjects(
    user: string,
    options?: ListChatProjectsOptions,
  ): Promise<ListChatProjectsResult>;
  /**
   * Sets the given fields of the user's project and resolves to it updated, or `null` when it
   * does not exist. Changed instructions bump `contextRevision`.
   */
  updateChatProject(
    user: string,
    projectId: string,
    input: UpdateChatProjectInput,
    limits?: Partial<ChatProjectLimits>,
  ): Promise<IChatProject | null>;
  /**
   * Deletes the user's project and detaches its conversations: `deletedCount` projects removed,
   * `modifiedCount` conversations detached.
   */
  deleteChatProject(user: string, projectId: string): Promise<DeleteChatProjectResult>;
  /** Deletes every project of the user (account erasure); resolves how many it removed. */
  deleteUserChatProjects(user: string): Promise<number>;
  /**
   * Attaches one of the user's searchable message files to the project (keeping it from
   * expiring) and resolves to the project, or `null` when it does not exist. Throws `Project
   * file unavailable` for a file that cannot be attached and `Project file limit reached` at
   * `maxFiles`. Attaching a file again is a no-op.
   */
  addChatProjectFile(
    user: string,
    projectId: string,
    fileId: string,
    limits?: Partial<ChatProjectLimits>,
  ): Promise<IChatProject | null>;
  /** Detaches the file and resolves to the project, or `null` when it does not exist. */
  removeChatProjectFile(
    user: string,
    projectId: string,
    fileId: string,
  ): Promise<IChatProject | null>;
  /**
   * Moves the user's conversation into the project, or out of any with `null`, refreshing both
   * projects' conversation stats. `null` when the conversation does not exist; throws `Project
   * not found` for a project the user does not have.
   */
  assignConversationToProject(
    user: string,
    conversationId: string,
    projectId: string | null,
  ): Promise<AssignConversationToProjectResult | null>;
}

/** Every method of {@link ChatProjectStore}, for adapters and conformance checks. */
export const CHAT_PROJECT_STORE_METHODS: ReadonlyArray<keyof ChatProjectStore> =
  listPortMethods<ChatProjectStore>({
    createChatProject: true,
    getChatProject: true,
    listChatProjects: true,
    updateChatProject: true,
    deleteChatProject: true,
    deleteUserChatProjects: true,
    addChatProjectFile: true,
    removeChatProjectFile: true,
    assignConversationToProject: true,
  });
