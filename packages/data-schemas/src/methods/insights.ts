import type { Model, PipelineStage } from 'mongoose';
import type {
  InsightsScope,
  InsightsMessageDay,
  InsightsDailyUsers,
  InsightsUserSummary,
  InsightsFirstMessage,
  InsightsMessageSummary,
  InsightsConversationDay,
  InsightsRecentConversation,
  InsightsChurnedUserSummary,
  InsightsChurnedUserActivity,
  InsightsLatestConversations,
  InsightsUserConversationCount,
  InsightsConversationMessageSummary,
} from './insightsRules';
import type { IUser, IMessage, IConversation, InsightsResult, InsightsOptions } from '~/types';
import { getInsightsWith } from './insightsRules';

export type { InsightsOptions, InsightsResult } from '~/types/insights';

export type InsightsMethods = {
  getInsights: (options?: InsightsOptions) => Promise<InsightsResult>;
};

type CountResult = { total: number };
type ConversationOwner = { conversationId: string; userId: string };

const churnedUserLimit = 8;

function tenantMatch(tenantId?: string) {
  return tenantId ? { tenantId } : { tenantId: { $exists: false } };
}

function joinedTenantMatch(tenantId?: string) {
  return tenantId
    ? { 'insightsConversation.tenantId': tenantId }
    : { 'insightsConversation.tenantId': { $exists: false } };
}

const conversationOwnerMatch = ({ conversationId, userId }: ConversationOwner) => ({
  conversationId,
  user: userId,
});

function conversationScope(match: Record<string, unknown>, agentIds: string[]): PipelineStage[] {
  return [
    {
      $match: {
        ...match,
        $or: [
          { initial_agent_id: { $in: agentIds } },
          { initial_agent_id: { $exists: false }, agent_id: { $in: agentIds } },
        ],
      },
    },
    { $addFields: { insightsAgentId: { $ifNull: ['$initial_agent_id', '$agent_id'] } } },
  ];
}

function messageScope(
  match: Record<string, unknown>,
  agentIds: string[],
  tenantId?: string,
): PipelineStage[] {
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
  return [
    { $match: attributedMatch },
    {
      $lookup: {
        from: 'conversations',
        localField: 'conversationId',
        foreignField: 'conversationId',
        as: 'insightsConversation',
      },
    },
    { $unwind: '$insightsConversation' },
    {
      $addFields: {
        insightsOwnerMatches: { $eq: ['$user', '$insightsConversation.user'] },
      },
    },
    {
      $match: {
        ...joinedTenantMatch(tenantId),
        'insightsConversation.isTemporary': { $ne: true },
        'insightsConversation.subagentThread': { $exists: false },
        'insightsConversation.user': { $nin: [null, ''] },
        insightsOwnerMatches: true,
        $or: [
          { isCreatedByUser: true, 'insightsConversation.initial_agent_id': { $in: agentIds } },
          {
            isCreatedByUser: true,
            'insightsConversation.initial_agent_id': { $exists: false },
            'insightsConversation.agent_id': { $in: agentIds },
          },
          {
            isCreatedByUser: { $ne: true },
            model: { $in: agentIds },
            $or: [
              {
                'insightsConversation.initial_agent_id': {
                  $exists: true,
                  $nin: [null, ''],
                },
              },
              {
                'insightsConversation.initial_agent_id': { $exists: false },
                'insightsConversation.agent_id': { $exists: true, $nin: [null, ''] },
              },
            ],
          },
        ],
      },
    },
  ];
}

export function createInsightsMethods(mongoose: typeof import('mongoose')): InsightsMethods {
  /** The pipelines each aggregate of the report runs (the rules assemble the report). */
  function pipelines(scope: InsightsScope) {
    const { agentIds, from, to, tenantId, searchRegex } = scope;
    const tenant = tenantMatch(tenantId);
    const conversationMatch = {
      ...tenant,
      isTemporary: { $ne: true },
      subagentThread: { $exists: false },
      user: { $nin: [null, ''] },
      createdAt: { $gte: from, $lte: to },
    };
    const messageMatch = {
      ...tenant,
      user: { $nin: [null, ''] },
      isTemporary: { $ne: true },
      createdAt: { $gte: from, $lte: to },
    };
    const conversationPipeline = conversationScope(conversationMatch, agentIds);
    const messagePipeline = messageScope(messageMatch, agentIds, tenantId);
    const searchedConversationPipeline: PipelineStage[] = searchRegex
      ? [
          ...conversationPipeline,
          {
            $addFields: {
              insightsUserId: {
                $convert: { input: '$user', to: 'objectId', onError: null, onNull: null },
              },
            },
          },
          {
            $lookup: {
              from: 'users',
              localField: 'insightsUserId',
              foreignField: '_id',
              as: 'matchedIdentity',
            },
          },
          {
            $match: {
              $or: [
                { conversationId: searchRegex },
                { user: searchRegex },
                {
                  matchedIdentity: {
                    $elemMatch: {
                      ...tenant,
                      $or: [
                        { name: searchRegex },
                        { username: searchRegex },
                        { email: searchRegex },
                      ],
                    },
                  },
                },
              ],
            },
          },
        ]
      : conversationPipeline;
    return {
      tenant,
      messageMatch,
      conversationPipeline,
      messagePipeline,
      searchedConversationPipeline,
    };
  }

  async function getInsights(options: InsightsOptions = {}): Promise<InsightsResult> {
    const Conversation = mongoose.models.Conversation as Model<IConversation>;
    const Message = mongoose.models.Message as Model<IMessage>;
    const User = mongoose.models.User as Model<IUser>;
    let built: ReturnType<typeof pipelines> | undefined;
    const of = (scope: InsightsScope) => (built ??= pipelines(scope));
    const latestMatch = (latest: InsightsLatestConversations) => ({
      conversationId: { $in: latest.conversationIds },
      $or: latest.owners.map(conversationOwnerMatch),
    });

    return getInsightsWith(
      {
        conversationDays: (scope) =>
          Conversation.aggregate<InsightsConversationDay>([
            ...of(scope).conversationPipeline,
            {
              $group: {
                _id: {
                  $dateToString: {
                    format: '%Y-%m-%d',
                    date: '$createdAt',
                    timezone: scope.timeZone,
                  },
                },
                conversations: { $sum: 1 },
              },
            },
            { $project: { _id: 0, date: '$_id', conversations: 1 } },
            { $sort: { date: 1 } },
          ]),
        latestConversations: (scope) =>
          Conversation.aggregate<InsightsRecentConversation>([
            ...of(scope).searchedConversationPipeline,
            { $sort: { createdAt: -1, _id: -1 } },
            { $skip: (scope.page - 1) * scope.pageSize },
            { $limit: scope.pageSize },
            {
              $project: {
                _id: 0,
                conversationId: 1,
                agentId: '$insightsAgentId',
                date: '$createdAt',
                userId: '$user',
              },
            },
          ]),
        searchedConversationCount: async (scope) =>
          (
            await Conversation.aggregate<CountResult>([
              ...of(scope).searchedConversationPipeline,
              { $count: 'total' },
            ])
          )[0]?.total ?? 0,
        messageDays: (scope) =>
          Message.aggregate<InsightsMessageDay>([
            ...of(scope).messagePipeline,
            {
              $group: {
                _id: {
                  $dateToString: {
                    format: '%Y-%m-%d',
                    date: '$createdAt',
                    timezone: scope.timeZone,
                  },
                },
                messages: { $sum: 1 },
                totalTokens: { $sum: { $ifNull: ['$tokenCount', 0] } },
              },
            },
            { $project: { _id: 0, date: '$_id', messages: 1, totalTokens: 1 } },
            { $sort: { date: 1 } },
          ]),
        userCount: async (scope) =>
          (
            await Message.aggregate<CountResult>([
              ...of(scope).messagePipeline,
              { $group: { _id: '$user' } },
              { $count: 'total' },
            ])
          )[0]?.total ?? 0,
        dailyUsers: (scope) =>
          Message.aggregate<InsightsDailyUsers>([
            ...of(scope).messagePipeline,
            {
              $group: {
                _id: {
                  date: {
                    $dateToString: {
                      format: '%Y-%m-%d',
                      date: '$createdAt',
                      timezone: scope.timeZone,
                    },
                  },
                  user: '$user',
                },
              },
            },
            { $group: { _id: '$_id.date', users: { $sum: 1 } } },
            { $project: { _id: 0, date: '$_id', users: 1 } },
            { $sort: { date: 1 } },
          ]),
        topMessageUsers: (scope) =>
          Message.aggregate<InsightsMessageSummary>([
            ...of(scope).messagePipeline,
            { $group: { _id: '$user', messages: { $sum: 1 } } },
            { $sort: { messages: -1, _id: 1 } },
            { $limit: 8 },
          ]),
        churnedUsers: (scope) =>
          Message.aggregate<InsightsChurnedUserActivity>([
            ...messageScope(
              {
                ...of(scope).tenant,
                isTemporary: { $ne: true },
                isCreatedByUser: true,
                user: { $nin: [null, ''] },
                createdAt: { $gte: scope.churnedActivityFrom, $lte: scope.to },
              },
              scope.agentIds,
              scope.tenantId,
            ),
            { $group: { _id: '$user', lastSeen: { $max: '$createdAt' } } },
            {
              $match: {
                lastSeen: { $gte: scope.churnedActivityFrom, $lte: scope.churnedCutoff },
              },
            },
            { $sort: { lastSeen: -1, _id: 1 } },
            { $limit: churnedUserLimit },
          ]),
        latestMessageSummaries: (scope, latest) =>
          Message.aggregate<InsightsConversationMessageSummary>([
            ...messageScope(
              { ...of(scope).messageMatch, ...latestMatch(latest) },
              scope.agentIds,
              scope.tenantId,
            ),
            {
              $group: {
                _id: { conversationId: '$conversationId', userId: '$user' },
                messages: { $sum: 1 },
                totalTokens: { $sum: { $ifNull: ['$tokenCount', 0] } },
              },
            },
          ]),
        firstMessages: (scope, latest) =>
          Message.aggregate<InsightsFirstMessage>([
            ...messageScope(
              {
                ...of(scope).tenant,
                isTemporary: { $ne: true },
                isCreatedByUser: true,
                ...latestMatch(latest),
              },
              scope.agentIds,
              scope.tenantId,
            ),
            { $sort: { createdAt: 1, _id: 1 } },
            {
              $group: {
                _id: { conversationId: '$conversationId', userId: '$user' },
                text: { $first: { $ifNull: ['$text', ''] } },
              },
            },
          ]),
        topConversationCounts: (scope, userIds) =>
          Message.aggregate<InsightsUserConversationCount>([
            ...messageScope(
              { ...of(scope).messageMatch, user: { $in: userIds } },
              scope.agentIds,
              scope.tenantId,
            ),
            { $group: { _id: { user: '$user', conversationId: '$conversationId' } } },
            { $group: { _id: '$_id.user', conversations: { $sum: 1 } } },
          ]),
        churnedUserSummaries: (scope, userIds) =>
          Message.aggregate<InsightsChurnedUserSummary>([
            ...messageScope(
              {
                ...of(scope).tenant,
                isTemporary: { $ne: true },
                isCreatedByUser: true,
                user: { $in: userIds },
                createdAt: { $lte: scope.to },
              },
              scope.agentIds,
              scope.tenantId,
            ),
            {
              $group: {
                _id: { user: '$user', conversationId: '$conversationId' },
                messages: { $sum: 1 },
                firstSeen: { $min: '$createdAt' },
              },
            },
            {
              $group: {
                _id: '$_id.user',
                conversations: { $sum: 1 },
                messages: { $sum: '$messages' },
                firstSeen: { $min: '$firstSeen' },
              },
            },
          ]),
        users: (scope, userIds) =>
          User.find({ ...of(scope).tenant, _id: { $in: userIds } })
            .select('_id name username email')
            .lean<InsightsUserSummary[]>(),
      },
      options,
    );
  }

  return { getInsights };
}
