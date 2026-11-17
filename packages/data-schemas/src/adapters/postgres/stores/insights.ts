/**
 * The PostgreSQL `InsightsStore` (`~/ports/insights`): the report of `~/methods/insightsRules`
 * over aggregates computed by hand-written SQL on the conversations, messages and users tables
 * (docs/postgres-port/PHASE4.md §4, "Aggregation with `$lookup`" and "Group, count, facet"). Must
 * not import `mongoose`, `mongodb` or `bson`.
 *
 * Each aggregate is one statement. The conditions are MongoDB's match stages translated by the
 * primitive's translator, so values are cast and `null`/missing and `$exists` follow the same
 * rules:
 * - the base table's conditions go through `storeWhere`, which also restricts them to the active
 *   tenant, as the tenant plugin restricts MongoDB's `aggregate`;
 * - the attributed messages join their conversation (MongoDB's `$lookup` on `conversationId`
 *   followed by the owner check) as `JOIN conversations c ON c."conversationId" =
 *   m."conversationId" AND c."user" = m."user"`, with the joined conversation's conditions
 *   translated without the active tenant (the `$lookup` is not scoped; the report names its
 *   tenant explicitly);
 * - calendar days are `to_char(<date> AT TIME ZONE <tz>, 'YYYY-MM-DD')` (`$dateToString` with
 *   `timezone`), `$group` stages are `GROUP BY` with `count(*)`, `count(DISTINCT ...)`, `sum`,
 *   `min`, `max`, the first message of a conversation is `DISTINCT ON`, and the search's identity
 *   match (`$convert` of the owner to an id, `$lookup` on users, `$elemMatch`) is an `EXISTS` on
 *   the users table by id.
 */
import { sql } from 'kysely';
import type {
  InsightsScope,
  InsightsSteps,
  InsightsMessageDay,
  InsightsDailyUsers,
  InsightsUserSummary,
  InsightsFirstMessage,
  InsightsMessageSummary,
  InsightsConversationDay,
  InsightsRecentConversation,
  InsightsChurnedUserSummary,
  InsightsChurnedUserActivity,
  InsightsUserConversationCount,
  InsightsConversationMessageSummary,
} from '~/methods/insightsRules';
import type { InsightsStore } from '~/ports/insights';
import type { PostgresStoreContext } from './context';
import type { SqlFragment } from '../query/sql';
import { getInsightsWith } from '~/methods/insightsRules';
import { runStoreSql, storeWhere } from './context';

type Filter = Record<string, unknown>;

const churnedUserLimit = 8;
const topUserLimit = 8;

function tenantMatch(tenantId?: string): Filter {
  return tenantId ? { tenantId } : { tenantId: { $exists: false } };
}

const toNumber = (value: unknown): number => Number(value ?? 0);

export function createPostgresInsightsStore(context: PostgresStoreContext): InsightsStore {
  /** A condition on the joined conversation `c` (not restricted to the active tenant). */
  const onConversation = (filter: Filter): SqlFragment =>
    context.collections().translator.filter('conversations', filter, { alias: 'c' });
  /** A condition on the attributed message `m` (not restricted to the active tenant). */
  const onMessage = (filter: Filter): SqlFragment =>
    context.collections().translator.filter('messages', filter, { alias: 'm' });

  const day = (column: SqlFragment, scope: InsightsScope) =>
    sql`to_char(${column} AT TIME ZONE ${scope.timeZone}, 'YYYY-MM-DD')`;

  /** The conversations of the scope: base conditions plus the agent attribution. */
  function conversationWhere(scope: InsightsScope): SqlFragment {
    return storeWhere(
      context,
      'conversations',
      {
        ...tenantMatch(scope.tenantId),
        isTemporary: { $ne: true },
        subagentThread: { $exists: false },
        user: { $nin: [null, ''] },
        createdAt: { $gte: scope.from, $lte: scope.to },
        $or: [
          { initial_agent_id: { $in: scope.agentIds } },
          { initial_agent_id: { $exists: false }, agent_id: { $in: scope.agentIds } },
        ],
      },
      { alias: 'c' },
    );
  }

  /** The search's condition on the scope's conversations (conversation id, owner, identity). */
  function searchWhere(scope: InsightsScope): SqlFragment {
    const regex = scope.searchRegex as RegExp;
    const identity = context.collections().translator.filter(
      'users',
      {
        ...tenantMatch(scope.tenantId),
        $or: [{ name: regex }, { username: regex }, { email: regex }],
      },
      { alias: 'u' },
    );
    return sql`(${onConversation({
      $or: [{ conversationId: regex }, { user: regex }],
    })} OR EXISTS (SELECT 1 FROM users u WHERE c."user" ~ '^[0-9a-fA-F]{24}$' AND u._id = lower(c."user") AND ${identity}))`;
  }

  function searchedConversationWhere(scope: InsightsScope): SqlFragment {
    return scope.searchRegex
      ? sql`${conversationWhere(scope)} AND ${searchWhere(scope)}`
      : conversationWhere(scope);
  }

  /**
   * `FROM messages m JOIN conversations c ... WHERE ...`: the messages matching `match` attributed
   * to the scope's agents, as MongoDB's `messageScope` stages select them.
   */
  function attributedMessages(scope: InsightsScope, match: Filter): SqlFragment {
    const { agentIds, tenantId } = scope;
    const attributedMatch =
      match.isCreatedByUser === true
        ? match
        : {
            $and: [
              match,
              {
                $or: [
                  { isCreatedByUser: true },
                  { isCreatedByUser: { $ne: true }, model: { $in: agentIds } },
                ],
              },
            ],
          };
    const createdByUser = onMessage({ isCreatedByUser: true });
    const notCreatedByUser = onMessage({
      isCreatedByUser: { $ne: true },
      model: { $in: agentIds },
    });
    return sql`FROM messages m JOIN conversations c ON c."conversationId" = m."conversationId" AND c."user" = m."user"
      WHERE ${storeWhere(context, 'messages', attributedMatch, { alias: 'm' })}
        AND ${onConversation({
          ...tenantMatch(tenantId),
          isTemporary: { $ne: true },
          subagentThread: { $exists: false },
          user: { $nin: [null, ''] },
        })}
        AND (
          (${createdByUser} AND ${onConversation({ initial_agent_id: { $in: agentIds } })})
          OR (${createdByUser} AND ${onConversation({
            initial_agent_id: { $exists: false },
            agent_id: { $in: agentIds },
          })})
          OR (${notCreatedByUser} AND ${onConversation({
            $or: [
              { initial_agent_id: { $exists: true, $nin: [null, ''] } },
              {
                initial_agent_id: { $exists: false },
                agent_id: { $exists: true, $nin: [null, ''] },
              },
            ],
          })})
        )`;
  }

  const messageMatch = (scope: InsightsScope): Filter => ({
    ...tenantMatch(scope.tenantId),
    user: { $nin: [null, ''] },
    isTemporary: { $ne: true },
    createdAt: { $gte: scope.from, $lte: scope.to },
  });

  const ownerMatch = (
    scope: InsightsScope,
    owners: Array<{ conversationId: string; userId: string }>,
  ) => ({
    conversationId: { $in: [...new Set(owners.map(({ conversationId }) => conversationId))] },
    $or: owners.map(({ conversationId, userId }) => ({ conversationId, user: userId })),
  });

  async function rows<R>(statement: SqlFragment): Promise<R[]> {
    return (await runStoreSql<R>(context, statement)).rows;
  }

  const steps: InsightsSteps = {
    async conversationDays(scope) {
      const found = await rows<{ date: string; conversations: number }>(
        sql`SELECT ${day(sql`c."createdAt"`, scope)} AS date, count(*)::int AS conversations
          FROM conversations c WHERE ${conversationWhere(scope)} GROUP BY 1 ORDER BY 1`,
      );
      return found.map(
        ({ date, conversations }): InsightsConversationDay => ({ conversations, date }),
      );
    },

    async latestConversations(scope) {
      const found = await rows<Record<string, unknown>>(
        sql`SELECT c."conversationId" AS "conversationId",
            coalesce(c."initial_agent_id", c."agent_id") AS "agentId",
            c."createdAt" AS date, c."user" AS "userId"
          FROM conversations c WHERE ${searchedConversationWhere(scope)}
          ORDER BY c."createdAt" DESC NULLS LAST, c._id DESC
          OFFSET ${(scope.page - 1) * scope.pageSize} LIMIT ${scope.pageSize}`,
      );
      /** `$project` leaves out the fields a conversation does not have. */
      return found.map(
        (row) =>
          Object.fromEntries(
            Object.entries(row).filter(([, value]) => value != null),
          ) as unknown as InsightsRecentConversation,
      );
    },

    async searchedConversationCount(scope) {
      const [found] = await rows<{ total: number }>(
        sql`SELECT count(*)::int AS total FROM conversations c WHERE ${searchedConversationWhere(scope)}`,
      );
      return found?.total ?? 0;
    },

    async messageDays(scope) {
      const found = await rows<{ date: string; messages: number; totalTokens: unknown }>(
        sql`SELECT ${day(sql`m."createdAt"`, scope)} AS date, count(*)::int AS messages,
            sum(coalesce(m."tokenCount", 0)) AS "totalTokens"
          ${attributedMessages(scope, messageMatch(scope))} GROUP BY 1 ORDER BY 1`,
      );
      return found.map(
        ({ date, messages, totalTokens }): InsightsMessageDay => ({
          messages,
          totalTokens: toNumber(totalTokens),
          date,
        }),
      );
    },

    async userCount(scope) {
      const [found] = await rows<{ total: number }>(
        sql`SELECT count(DISTINCT m."user")::int AS total ${attributedMessages(scope, messageMatch(scope))}`,
      );
      return found?.total ?? 0;
    },

    async dailyUsers(scope) {
      const found = await rows<{ date: string; users: number }>(
        sql`SELECT ${day(sql`m."createdAt"`, scope)} AS date, count(DISTINCT m."user")::int AS users
          ${attributedMessages(scope, messageMatch(scope))} GROUP BY 1 ORDER BY 1`,
      );
      return found.map(({ date, users }): InsightsDailyUsers => ({ users, date }));
    },

    async topMessageUsers(scope) {
      return rows<InsightsMessageSummary>(
        sql`SELECT m."user" AS "_id", count(*)::int AS messages
          ${attributedMessages(scope, messageMatch(scope))}
          GROUP BY m."user" ORDER BY messages DESC, m."user" ASC LIMIT ${topUserLimit}`,
      );
    },

    async churnedUsers(scope) {
      return rows<InsightsChurnedUserActivity>(
        sql`SELECT m."user" AS "_id", max(m."createdAt") AS "lastSeen"
          ${attributedMessages(scope, {
            ...tenantMatch(scope.tenantId),
            isTemporary: { $ne: true },
            isCreatedByUser: true,
            user: { $nin: [null, ''] },
            createdAt: { $gte: scope.churnedActivityFrom, $lte: scope.to },
          })}
          GROUP BY m."user"
          HAVING max(m."createdAt") >= ${scope.churnedActivityFrom}
            AND max(m."createdAt") <= ${scope.churnedCutoff}
          ORDER BY "lastSeen" DESC, m."user" ASC LIMIT ${churnedUserLimit}`,
      );
    },

    async latestMessageSummaries(scope, latest) {
      const found = await rows<{
        conversationId: string;
        userId: string;
        messages: number;
        totalTokens: unknown;
      }>(
        sql`SELECT m."conversationId" AS "conversationId", m."user" AS "userId",
            count(*)::int AS messages, sum(coalesce(m."tokenCount", 0)) AS "totalTokens"
          ${attributedMessages(scope, { ...messageMatch(scope), ...ownerMatch(scope, latest.owners) })}
          GROUP BY m."conversationId", m."user"`,
      );
      return found.map(
        ({
          conversationId,
          userId,
          messages,
          totalTokens,
        }): InsightsConversationMessageSummary => ({
          _id: { conversationId, userId },
          messages,
          totalTokens: toNumber(totalTokens),
        }),
      );
    },

    async firstMessages(scope, latest) {
      const found = await rows<{ conversationId: string; userId: string; text: string }>(
        sql`SELECT DISTINCT ON (m."conversationId", m."user")
            m."conversationId" AS "conversationId", m."user" AS "userId",
            coalesce(m."text", '') AS text
          ${attributedMessages(scope, {
            ...tenantMatch(scope.tenantId),
            isTemporary: { $ne: true },
            isCreatedByUser: true,
            ...ownerMatch(scope, latest.owners),
          })}
          ORDER BY m."conversationId", m."user", m."createdAt" ASC NULLS FIRST, m._id ASC`,
      );
      return found.map(
        ({ conversationId, userId, text }): InsightsFirstMessage => ({
          _id: { conversationId, userId },
          text,
        }),
      );
    },

    async topConversationCounts(scope, userIds) {
      return rows<InsightsUserConversationCount>(
        sql`SELECT m."user" AS "_id", count(DISTINCT m."conversationId")::int AS conversations
          ${attributedMessages(scope, { ...messageMatch(scope), user: { $in: userIds } })}
          GROUP BY m."user"`,
      );
    },

    async churnedUserSummaries(scope, userIds) {
      return rows<InsightsChurnedUserSummary>(
        sql`SELECT m."user" AS "_id", count(DISTINCT m."conversationId")::int AS conversations,
            count(*)::int AS messages, min(m."createdAt") AS "firstSeen"
          ${attributedMessages(scope, {
            ...tenantMatch(scope.tenantId),
            isTemporary: { $ne: true },
            isCreatedByUser: true,
            user: { $in: userIds },
            createdAt: { $lte: scope.to },
          })}
          GROUP BY m."user"`,
      );
    },

    async users(scope, userIds) {
      return (await context
        .collections()
        .collection('users')
        .find(
          { ...tenantMatch(scope.tenantId), _id: { $in: userIds } },
          { projection: '_id name username email' },
        )) as unknown as InsightsUserSummary[];
    },
  };

  const store: InsightsStore = {
    getInsights: (options) => getInsightsWith(steps, options),
  };
  return store;
}
