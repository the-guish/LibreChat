/**
 * The database-neutral rules of chat projects, shared by the MongoDB methods (`./chatProject`)
 * and the PostgreSQL stores: which conversations a project counts, the compare-and-set refresh
 * that recomputes them, and the activity pointer a newer conversation moves forward; the input
 * limits and sanitization, the listing's order, cursor and filter, the guarded update with its
 * revision check, and the file attach with its temporary-hold release. Storage goes through the
 * steps each backend supplies. Nothing here may import `mongoose` or touch a model.
 */
import {
  FileContext,
  MAX_CHAT_PROJECT_FILES,
  MAX_CHAT_PROJECT_NAME_LENGTH,
  MAX_CHAT_PROJECT_DESCRIPTION_LENGTH,
  MAX_CHAT_PROJECT_INSTRUCTIONS_LENGTH,
} from 'librechat-data-provider';
import type {
  IChatProject,
  IConversation,
  ChatProjectSortBy,
  ChatProjectLimits,
  CreateChatProjectInput,
  UpdateChatProjectInput,
  ListChatProjectsOptions,
  ChatProjectSortDirection,
} from '~/types';
import { buildRetentionVisibilityFilter } from '~/utils/retention';
import { isValidObjectIdString } from '~/utils/objectId';
import { escapeRegExp } from '~/utils/string';
import logger from '~/config/winston';

/** A filter or an update in the query language both backends speak. */
type Query = Record<string, unknown>;

/** The statistics a refresh compares and sets. */
export type ProjectStatsSnapshot = Pick<
  IChatProject,
  'conversationCount' | 'lastConversationAt' | 'lastConversationId'
>;

/** How many times a refresh recomputes when the statistics changed under it. */
export const PROJECT_STATS_REFRESH_MAX_ATTEMPTS = 8;

/** The conversations a project counts: the owner's visible, unarchived chats in it. */
export function visibleProjectConversationFilter(user: string, projectId: string): Query {
  return {
    $and: [
      { user, chatProjectId: projectId },
      { $or: [{ isArchived: false }, { isArchived: { $exists: false } }] },
      buildRetentionVisibilityFilter(),
    ],
  };
}

/** The project still holding the statistics a refresh read. */
export function projectStatsSnapshotFilter(snapshot: ProjectStatsSnapshot): Query {
  return {
    conversationCount:
      snapshot.conversationCount === undefined ? { $exists: false } : snapshot.conversationCount,
    lastConversationAt:
      snapshot.lastConversationAt === undefined ? { $exists: false } : snapshot.lastConversationAt,
    lastConversationId:
      snapshot.lastConversationId === undefined ? { $exists: false } : snapshot.lastConversationId,
  };
}

/** What a statistics refresh reads and writes, scoped to one project of one user. */
export interface ProjectStatsRefreshSteps<P> {
  /** The project's statistics, or `null` when the user owns no such project. */
  readSnapshot(): Promise<ProjectStatsSnapshot | null>;
  /** How many conversations match `filter`. */
  countConversations(filter: Query): Promise<number>;
  /** The most recently updated conversation matching `filter` (`updatedAt`, then `_id`, desc). */
  latestConversation(
    filter: Query,
  ): Promise<Pick<IConversation, 'conversationId' | 'updatedAt' | 'createdAt'> | null>;
  /** Writes `set` on the project while it still matches `snapshotFilter`; `null` when not. */
  writeIfUnchanged(snapshotFilter: Query, set: Query): Promise<P | null>;
}

/**
 * Recomputes one project's statistics from scratch by compare-and-set: the write applies only
 * while the statistics are those read, and is recomputed otherwise, up to
 * {@link PROJECT_STATS_REFRESH_MAX_ATTEMPTS} times. `null` when the user owns no such project.
 */
export async function refreshChatProjectStatsWith<P>(
  steps: ProjectStatsRefreshSteps<P>,
  user: string,
  projectId: string,
): Promise<P | null> {
  const conversationFilter = visibleProjectConversationFilter(user, projectId);
  for (let attempt = 0; attempt < PROJECT_STATS_REFRESH_MAX_ATTEMPTS; attempt++) {
    const snapshot = await steps.readSnapshot();
    if (!snapshot) {
      return null;
    }

    const [conversationCount, latestConversation] = await Promise.all([
      steps.countConversations(conversationFilter),
      steps.latestConversation(conversationFilter),
    ]);

    const updatedProject = await steps.writeIfUnchanged(projectStatsSnapshotFilter(snapshot), {
      conversationCount,
      lastConversationAt: latestConversation?.updatedAt ?? latestConversation?.createdAt ?? null,
      lastConversationId: latestConversation?.conversationId ?? null,
    });
    if (updatedProject) {
      return updatedProject;
    }
  }

  logger.warn('[refreshChatProjectStatsForUser] Stats changed during every refresh attempt', {
    user,
    projectId,
  });
  throw new Error('Failed to refresh chat project stats after concurrent updates');
}

/** What moving a project's activity pointer reads and writes. */
export interface ProjectActivitySteps {
  /** Updates the user's project matching `condition` (beyond its id and user). */
  updateProject(condition: Query, update: Query): Promise<{ matchedCount: number }>;
  /** Whether a conversation matches `filter`. */
  conversationExists(filter: Query): Promise<boolean>;
  /** Recomputes the project's statistics. */
  refresh(): Promise<unknown>;
}

/**
 * Moves the project's last-conversation pointer to `conversation` when it is newer, counting it
 * in when `incrementCount`, and recomputes the project when the chat it names turned out to be
 * hidden by the time the pointer landed.
 */
export async function updateChatProjectLastConversationWith(
  steps: ProjectActivitySteps,
  user: string,
  projectId: string,
  conversation: Pick<IConversation, 'conversationId' | 'createdAt' | 'updatedAt'>,
  incrementCount = false,
): Promise<void> {
  const lastConversationAt = conversation.updatedAt ?? conversation.createdAt ?? new Date();
  const lastConversationFields = {
    lastConversationAt,
    lastConversationId: conversation.conversationId,
  };
  const activityCondition = {
    $or: [{ lastConversationAt: null }, { lastConversationAt: { $lte: lastConversationAt } }],
  };

  if (!incrementCount) {
    await steps.updateProject(activityCondition, { $set: lastConversationFields });
  } else {
    /**
     * A refresh may already have counted this conversation, or a newer reply may own the
     * activity pointer. Recount after a lost conditional update rather than double-counting
     * membership or walking the pointer backwards.
     */
    const incremented = await steps.updateProject(
      { ...activityCondition, lastConversationId: { $ne: conversation.conversationId } },
      { $set: lastConversationFields, $inc: { conversationCount: 1 } },
    );
    if ((incremented.matchedCount ?? 0) === 0) {
      await steps.refresh();
      return;
    }
  }
  /**
   * The chat can stop being visible while this pointer write is in flight: an archive-all
   * sweep, a single archive from another tab, or a retention flip, each of which has
   * already run its own stats refresh by the time this lands, leaving the project
   * advertising activity on a chat its workspace hides. Checking first would only move
   * that race earlier, so the pointer is verified after it is written and the project
   * recomputed when the chat it names turns out to be hidden. A sweep that lands later
   * still refreshes the project itself, and the refresh compare-and-sets, so it cannot
   * commit a count it read before this write. The read is a point lookup on the unique
   * `conversationId, user` index.
   */
  const stillVisible = await steps.conversationExists({
    ...visibleProjectConversationFilter(user, projectId),
    conversationId: conversation.conversationId,
  });
  if (!stillVisible) {
    await steps.refresh();
  }
}

/* ------------------------------------------------------------------ project records and lists */

export const CHAT_PROJECT_CONFLICT = 'Project revision conflict';

/** A listing cursor: the sort value of the last project of the page, and its record id. */
export type ChatProjectCursor = {
  primary: string | null;
  id: string;
};

const VALID_SORT_FIELDS = new Set<ChatProjectSortBy>(['name', 'createdAt', 'lastConversationAt']);

export const resolveChatProjectLimits = (
  limits?: Partial<ChatProjectLimits>,
): ChatProjectLimits => ({
  maxFiles: limits?.maxFiles ?? MAX_CHAT_PROJECT_FILES,
  maxInstructionsLength: limits?.maxInstructionsLength ?? MAX_CHAT_PROJECT_INSTRUCTIONS_LENGTH,
  maxDescriptionLength: limits?.maxDescriptionLength ?? MAX_CHAT_PROJECT_DESCRIPTION_LENGTH,
});

export function normalizeChatProjectSortBy(sortBy?: string): ChatProjectSortBy {
  return VALID_SORT_FIELDS.has(sortBy as ChatProjectSortBy)
    ? (sortBy as ChatProjectSortBy)
    : 'lastConversationAt';
}

export function normalizeChatProjectSortDirection(
  sortDirection?: string,
): ChatProjectSortDirection {
  return sortDirection === 'asc' ? 'asc' : 'desc';
}

export function normalizeChatProjectLimit(limit?: number): number {
  if (!Number.isFinite(limit) || !limit) {
    return 25;
  }
  return Math.min(Math.max(Math.floor(limit), 1), 100);
}

export function validateProjectInstructions(
  instructions: string | undefined,
  limits?: Partial<ChatProjectLimits>,
): string {
  if (instructions === undefined) {
    return '';
  }
  const { maxInstructionsLength } = resolveChatProjectLimits(limits);
  if (typeof instructions !== 'string' || instructions.length > maxInstructionsLength) {
    throw new Error('Invalid project instructions');
  }
  return instructions.trim();
}

export function sanitizeProjectInput(
  input: CreateChatProjectInput,
  limits?: Partial<ChatProjectLimits>,
): CreateChatProjectInput {
  const { maxDescriptionLength } = resolveChatProjectLimits(limits);
  return {
    name: input.name.trim().slice(0, MAX_CHAT_PROJECT_NAME_LENGTH),
    description: input.description?.trim().slice(0, maxDescriptionLength) ?? '',
    instructions: validateProjectInstructions(input.instructions, limits),
  };
}

export function parseChatProjectCursor(cursor?: string | null): ChatProjectCursor | null {
  if (!cursor) {
    return null;
  }

  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64').toString()) as ChatProjectCursor;
    if (!decoded.id || !isValidObjectIdString(decoded.id)) {
      return null;
    }
    return {
      primary: decoded.primary ?? null,
      id: decoded.id,
    };
  } catch {
    logger.warn('[listChatProjects] Invalid cursor format, starting from beginning');
    return null;
  }
}

export function encodeChatProjectCursor(
  project: Pick<IChatProject, 'name' | 'createdAt' | 'lastConversationAt'> & { _id?: unknown },
  sortBy: ChatProjectSortBy,
): string {
  let primary: string | null = null;
  if (sortBy === 'name') {
    primary = project.name;
  } else {
    const date = project[sortBy];
    primary = date instanceof Date ? date.toISOString() : null;
  }
  return Buffer.from(JSON.stringify({ primary, id: String(project._id) })).toString('base64');
}

function cursorPrimaryValue(
  primary: string | null,
  sortBy: ChatProjectSortBy,
): string | Date | null | undefined {
  if (primary == null) {
    return sortBy === 'lastConversationAt' ? null : undefined;
  }

  if (sortBy === 'name') {
    return primary;
  }

  const date = new Date(primary);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/**
 * The condition of the projects after the cursor's, in the listing's order; `null` without a
 * (valid) cursor. `toId` is the id value a record id string compares as in a filter.
 */
export function chatProjectCursorFilter(
  cursor: ChatProjectCursor | null,
  sortBy: ChatProjectSortBy,
  sortDirection: ChatProjectSortDirection,
  toId: (id: string) => unknown,
): Query | null {
  if (!cursor) {
    return null;
  }

  const op = sortDirection === 'asc' ? '$gt' : '$lt';
  const id = toId(cursor.id);
  const primary = cursorPrimaryValue(cursor.primary, sortBy);

  if (primary === undefined) {
    logger.warn('[listChatProjects] Invalid cursor primary value, starting from beginning');
    return null;
  }

  const branches: Query[] = [
    { [sortBy]: { [op]: primary } },
    { [sortBy]: primary, _id: { [op]: id } },
  ];

  /**
   * Projects with no conversations have `lastConversationAt: null`, which sorts
   * after all dated projects in descending order. A `$lt: <date>` predicate does
   * not match null, so once the cursor moves past the dated projects we must
   * include the null bucket explicitly, otherwise empty projects never paginate.
   */
  if (sortBy === 'lastConversationAt' && sortDirection === 'desc' && primary instanceof Date) {
    branches.push({ lastConversationAt: null });
  }

  return { $or: branches };
}

/** What a listing reads: the filter, the order and the page size (plus one, to see a next page). */
export interface ChatProjectListPlan {
  filter: Query;
  sortBy: ChatProjectSortBy;
  sortDirection: ChatProjectSortDirection;
  limit: number;
}

/** The plan of `listChatProjects` for the user's options. */
export function planChatProjectList(
  user: string,
  options: ListChatProjectsOptions,
  toId: (id: string) => unknown,
): ChatProjectListPlan {
  const limit = normalizeChatProjectLimit(options.limit);
  const sortBy = normalizeChatProjectSortBy(options.sortBy);
  const sortDirection = normalizeChatProjectSortDirection(options.sortDirection);
  const filters: Query[] = [{ user }];

  if (options.search?.trim()) {
    const searchRegex = { $regex: escapeRegExp(options.search.trim()), $options: 'i' };
    filters.push({ $or: [{ name: searchRegex }, { description: searchRegex }] });
  }

  const cursorFilter = chatProjectCursorFilter(
    parseChatProjectCursor(options.cursor),
    sortBy,
    sortDirection,
    toId,
  );
  if (cursorFilter) {
    filters.push(cursorFilter);
  }

  const filter = filters.length === 1 ? filters[0] : { $and: filters };
  return { filter, sortBy, sortDirection, limit };
}

/* ------------------------------------------------------------------ guarded project writes */

/** What `updateChatProject` reads and writes, scoped to one project of one user. */
export interface ChatProjectUpdateSteps {
  /**
   * Applies `update` (validated) to the project while it also matches `condition`, and resolves
   * it updated; `null` when it does not match.
   */
  writeProject(condition: Query, update: Query): Promise<IChatProject | null>;
  /** The project, or `null`. */
  getProject(): Promise<IChatProject | null>;
}

/**
 * Sets the given fields of the project: changed instructions bump `contextRevision`, and an
 * expected revision that the project moved past throws {@link CHAT_PROJECT_CONFLICT}.
 */
export async function updateChatProjectWith(
  steps: ChatProjectUpdateSteps,
  input: UpdateChatProjectInput,
  limits?: Partial<ChatProjectLimits>,
): Promise<IChatProject | null> {
  const update: Partial<Pick<IChatProject, 'name' | 'description' | 'instructions'>> = {};
  const { maxDescriptionLength } = resolveChatProjectLimits(limits);
  if (typeof input.name === 'string') {
    const name = input.name.trim().slice(0, MAX_CHAT_PROJECT_NAME_LENGTH);
    if (!name) {
      throw new Error('Project name is required');
    }
    update.name = name;
  }
  if (input.description !== undefined) {
    update.description = input.description?.trim().slice(0, maxDescriptionLength) ?? '';
  }
  const expected = input.contextRevision;
  const hasExpected = typeof expected === 'number' && Number.isInteger(expected);
  const condition: Query = hasExpected ? { contextRevision: expected } : {};
  const conflictOrNull = async (): Promise<IChatProject | null> => {
    if (!hasExpected) {
      return null;
    }
    const current = await steps.getProject();
    if (current) {
      throw new Error(CHAT_PROJECT_CONFLICT);
    }
    return null;
  };
  if (input.instructions !== undefined) {
    const instructions = validateProjectInstructions(input.instructions, limits);
    const changed = await steps.writeProject(
      {
        ...condition,
        instructions: instructions === '' ? { $nin: ['', null] } : { $ne: instructions },
      },
      { $set: { ...update, instructions }, $inc: { contextRevision: 1 } },
    );
    if (changed) {
      return changed;
    }
  }
  if (Object.keys(update).length === 0) {
    const current = await steps.getProject();
    if (current && hasExpected && current.contextRevision !== expected) {
      throw new Error(CHAT_PROJECT_CONFLICT);
    }
    return current;
  }
  const saved = await steps.writeProject(condition, { $set: update });
  return saved ?? (await conflictOrNull());
}

/** A file record as attaching it to a project reads it. */
export interface ChatProjectFileHold {
  _id: unknown;
  expiresAt?: Date | null;
  temp_file_id?: string | null;
}

/** What `addChatProjectFile` reads and writes. */
export interface ChatProjectFileSteps {
  /** The user's project, or `null`. */
  getProject(): Promise<IChatProject | null>;
  /** The file matching `filter` (`_id`, `file_id`, `expiresAt`, `temp_file_id`), or `null`. */
  findFile(filter: Query): Promise<ChatProjectFileHold | null>;
  /** Updates the file matching `filter`, leaving `updatedAt` as it is. */
  updateFile(filter: Query, update: Query): Promise<{ matchedCount: number }>;
  /** Whether a file matches `filter`. */
  fileExists(filter: Query): Promise<boolean>;
  /** Updates the project matching `filter`. */
  updateProject(filter: Query, update: Query): Promise<unknown>;
  /** Applies `update` (validated) to the project matching `filter` and resolves it updated. */
  attachToProject(filter: Query, update: Query): Promise<IChatProject | null>;
}

/**
 * Attaches one of the user's searchable message files to the project, releasing its temporary
 * hold (restored when the attach does not happen), within `maxFiles`; a file deleted between the
 * release and the attach is taken back out.
 */
export async function addChatProjectFileWith(
  steps: ChatProjectFileSteps,
  user: string,
  fileId: string,
  limits?: Partial<ChatProjectLimits>,
): Promise<IChatProject | null> {
  const { maxFiles } = resolveChatProjectLimits(limits);
  const project = await steps.getProject();
  if (!project) {
    return null;
  }
  if (!fileId || typeof fileId !== 'string' || fileId.length > 128) {
    throw new Error('Project file unavailable');
  }
  const alreadyAttached = project.file_ids?.includes(fileId) === true;
  if (!alreadyAttached && (project.file_ids?.length ?? 0) >= maxFiles) {
    throw new Error('Project file limit reached');
  }

  const file = await steps.findFile({
    file_id: fileId,
    user,
    tenantId: project.tenantId ?? null,
    context: FileContext.message_attachment,
    $and: [
      { $or: [{ embedded: true }, { 'metadata.searchDestination': true }] },
      { $or: [{ expiredAt: null }, { expiredAt: { $gt: new Date() } }] },
    ],
  });
  if (!file) {
    throw new Error('Project file unavailable');
  }

  const released = await steps.updateFile(
    { _id: file._id, file_id: fileId, user, tenantId: project.tenantId ?? null },
    { $unset: { expiresAt: '', temp_file_id: '' } },
  );
  if (released.matchedCount === 0) {
    throw new Error('Project file unavailable');
  }
  const restoreTemporaryHold = async (): Promise<void> => {
    const hold = {
      ...(file.expiresAt != null ? { expiresAt: file.expiresAt } : {}),
      ...(file.temp_file_id != null ? { temp_file_id: file.temp_file_id } : {}),
    };
    if (Object.keys(hold).length === 0) {
      return;
    }
    try {
      await steps.updateFile({ _id: file._id, user }, { $set: hold });
    } catch (error) {
      logger.warn('[chatProject] Failed to restore temporary file hold', error);
    }
  };

  /** A file deleted between the release and the attach has already run its project
   *  cleanup, so the reference added after it would dangle; take it back out. */
  const dropIfFileDeleted = async (attached: IChatProject): Promise<IChatProject> => {
    if (await steps.fileExists({ _id: file._id })) {
      return attached;
    }
    await steps.updateProject(
      { _id: project._id, user, file_ids: fileId },
      { $pull: { file_ids: fileId }, $inc: { contextRevision: 1 } },
    );
    throw new Error('Project file unavailable');
  };
  try {
    const updated = await steps.attachToProject(
      {
        _id: project._id,
        user,
        file_ids: { $ne: fileId },
        [`file_ids.${maxFiles - 1}`]: { $exists: false },
      },
      { $addToSet: { file_ids: fileId }, $inc: { contextRevision: 1 } },
    );
    if (updated) {
      return await dropIfFileDeleted(updated);
    }
    const current = await steps.getProject();
    if (current?.file_ids?.includes(fileId)) {
      return current;
    }
    await restoreTemporaryHold();
    if (!current) {
      return null;
    }
  } catch (error) {
    await restoreTemporaryHold();
    throw error;
  }
  throw new Error('Project file limit reached');
}
