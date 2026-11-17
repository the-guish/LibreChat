/**
 * The database-neutral rules of a chat project's conversation statistics, shared by the MongoDB
 * methods (`./chatProject`) and the PostgreSQL conversation store: which conversations a project
 * counts, the compare-and-set refresh that recomputes them, and the activity pointer a newer
 * conversation moves forward. Storage goes through the steps each backend supplies. Nothing here
 * may import `mongoose` or touch a model.
 */
import type { IChatProject, IConversation } from '~/types';
import { buildRetentionVisibilityFilter } from '~/utils/retention';
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
