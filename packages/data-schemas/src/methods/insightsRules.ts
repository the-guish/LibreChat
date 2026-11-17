/**
 * The database-neutral rules of the insights report, shared by the MongoDB methods
 * (`./insights`) and the PostgreSQL store: the range (presets, a custom range capped to the
 * longest one allowed, calendar days in the viewer's time zone), the paging and search bounds,
 * and the report assembled from the aggregates each backend computes ({@link InsightsSteps}),
 * read in two rounds (the second needs the first's users and conversations). Nothing here may
 * import `mongoose` or touch a model.
 */
import {
  INSIGHTS_MAX_RANGE_DAYS,
  INSIGHTS_SEARCH_MAX_LENGTH,
  INSIGHTS_SEARCH_MIN_LENGTH,
} from 'librechat-data-provider';
import type {
  TInsightsChurnedUser,
  TInsightsConversation,
  TInsightsDailyPoint,
  TInsightsUser,
} from 'librechat-data-provider';
import type { InsightsResult, InsightsOptions } from '~/types';

type UserMessageTotals = { messages: number };

/** Conversations started per calendar day. */
export type InsightsConversationDay = { date: string; conversations: number };
/** Distinct active users per calendar day. */
export type InsightsDailyUsers = { date: string; users: number };
/** Messages and tokens per calendar day. */
export type InsightsMessageDay = { date: string; messages: number; totalTokens: number };
/** A conversation of the latest page. */
export type InsightsRecentConversation = {
  conversationId: string;
  agentId: string;
  date: Date;
  userId: string;
};
/** A user's message count (`_id` is the user). */
export type InsightsMessageSummary = UserMessageTotals & { _id: string };
/** A user's last activity (`_id` is the user). */
export type InsightsChurnedUserActivity = { _id: string; lastSeen: Date };
/** A churned user's totals (`_id` is the user). */
export type InsightsChurnedUserSummary = UserMessageTotals & {
  _id: string;
  conversations: number;
  firstSeen: Date;
};
/** A conversation and its owner. */
export type InsightsConversationOwner = { conversationId: string; userId: string };
/** A conversation's message and token totals. */
export type InsightsConversationMessageSummary = UserMessageTotals & {
  _id: InsightsConversationOwner;
  totalTokens: number;
};
/** A user's count of conversations (`_id` is the user). */
export type InsightsUserConversationCount = { _id: string; conversations: number };
/** A conversation's first user message. */
export type InsightsFirstMessage = { _id: InsightsConversationOwner; text: string };
/** A user's identity. */
export type InsightsUserSummary = {
  _id: { toString(): string };
  name?: string;
  username?: string;
  email?: string;
};

/** What every aggregate of one report is computed over. */
export interface InsightsScope {
  /** The attributed agents, distinct and sorted. */
  agentIds: string[];
  tenantId?: string;
  /** A valid IANA time zone (`UTC` when none or an invalid one was given). */
  timeZone: string;
  from: Date;
  to: Date;
  /** Users last seen at or before this are churned. */
  churnedCutoff: Date;
  /** How far back a churned user's activity is read. */
  churnedActivityFrom: Date;
  /** The search (case-insensitive, literal), or `''` for none. */
  search: string;
  /** The search as a case-insensitive literal regular expression, when there is one. */
  searchRegex?: RegExp;
  page: number;
  pageSize: number;
}

/** The latest page's conversations, as the second round reads them. */
export interface InsightsLatestConversations {
  /** The distinct conversation ids, in page order. */
  conversationIds: string[];
  /** Each conversation and its owner, in page order. */
  owners: InsightsConversationOwner[];
}

/**
 * The aggregates of a report, as each backend computes them; every one counts only the scope's
 * tenant (records outside any tenant without one), attributed agents, and records that are not
 * temporary or subagent threads (see `~/ports/insights`).
 */
export interface InsightsSteps {
  /** Conversations started per day (the scope's time zone), by date. */
  conversationDays(scope: InsightsScope): Promise<InsightsConversationDay[]>;
  /** The page of conversations, matching the search when there is one, newest first. */
  latestConversations(scope: InsightsScope): Promise<InsightsRecentConversation[]>;
  /** How many conversations match the search (called only with a search). */
  searchedConversationCount(scope: InsightsScope): Promise<number>;
  /** Messages and tokens per day, by date. */
  messageDays(scope: InsightsScope): Promise<InsightsMessageDay[]>;
  /** How many distinct users wrote attributed messages. */
  userCount(scope: InsightsScope): Promise<number>;
  /** Distinct active users per day, by date. */
  dailyUsers(scope: InsightsScope): Promise<InsightsDailyUsers[]>;
  /** The 8 users with the most messages (ties by user id). */
  topMessageUsers(scope: InsightsScope): Promise<InsightsMessageSummary[]>;
  /** Up to 8 users last seen within the churn window, most recent first. */
  churnedUsers(scope: InsightsScope): Promise<InsightsChurnedUserActivity[]>;
  /** The message and token totals of the latest conversations. */
  latestMessageSummaries(
    scope: InsightsScope,
    latest: InsightsLatestConversations,
  ): Promise<InsightsConversationMessageSummary[]>;
  /** The first user message of each latest conversation. */
  firstMessages(
    scope: InsightsScope,
    latest: InsightsLatestConversations,
  ): Promise<InsightsFirstMessage[]>;
  /** How many conversations each listed user wrote attributed messages in. */
  topConversationCounts(
    scope: InsightsScope,
    userIds: string[],
  ): Promise<InsightsUserConversationCount[]>;
  /** The listed churned users' conversations, messages and first activity. */
  churnedUserSummaries(
    scope: InsightsScope,
    userIds: string[],
  ): Promise<InsightsChurnedUserSummary[]>;
  /** The identities of the listed users (of the scope's tenant). */
  users(scope: InsightsScope, userIds: string[]): Promise<InsightsUserSummary[]>;
}

const rangeDays = { '24h': 1, '7d': 7, '30d': 30 };
const defaultRange = '7d';
const churnedUserWindowDays = 28;
const dayMs = 24 * 60 * 60 * 1000;

function validTimeZone(timeZone?: string) {
  if (!timeZone) return 'UTC';
  try {
    new Intl.DateTimeFormat('en', { timeZone }).format();
    return timeZone;
  } catch {
    return 'UTC';
  }
}

/** The calendar day (`YYYY-MM-DD`) of `date` in `timeZone`. */
export function insightsDateKey(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en', {
    day: '2-digit',
    month: '2-digit',
    timeZone,
    year: 'numeric',
  }).formatToParts(date);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  return `${values.get('year')}-${values.get('month')}-${values.get('day')}`;
}

function dateKeyValue(key: string) {
  const [year, month, day] = key.split('-').map(Number);
  return Date.UTC(year, month - 1, day);
}

function addCalendarDaysToKey(key: string, days: number) {
  const date = new Date(dateKeyValue(key));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function calendarDayDifference(startKey: string, endKey: string) {
  return Math.round((dateKeyValue(endKey) - dateKeyValue(startKey)) / dayMs);
}

function startOfZonedDate(key: string, timeZone: string) {
  const target = dateKeyValue(key);
  let instant = target;
  const formatter = new Intl.DateTimeFormat('en', {
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
    minute: '2-digit',
    month: '2-digit',
    second: '2-digit',
    timeZone,
    year: 'numeric',
  });

  for (let iteration = 0; iteration < 2; iteration += 1) {
    const parts = new Map(
      formatter.formatToParts(new Date(instant)).map((part) => [part.type, part.value]),
    );
    const rendered = Date.UTC(
      Number(parts.get('year')),
      Number(parts.get('month')) - 1,
      Number(parts.get('day')),
      Number(parts.get('hour')),
      Number(parts.get('minute')),
      Number(parts.get('second')),
    );
    instant += target - rendered;
  }
  return new Date(instant);
}

function resolveRange(options: InsightsOptions) {
  const now = new Date();
  const range = options.range ?? defaultRange;

  if (range === 'custom' && options.fromTimestamp && options.toTimestamp) {
    const customFrom = new Date(options.fromTimestamp);
    const customTo = new Date(options.toTimestamp);
    if (Number.isFinite(customFrom.getTime()) && Number.isFinite(customTo.getTime())) {
      const [start, end] = customFrom <= customTo ? [customFrom, customTo] : [customTo, customFrom];
      const timeZone = validTimeZone(options.timeZone);
      const startKey = insightsDateKey(start, timeZone);
      const endKey = insightsDateKey(end, timeZone);
      if (calendarDayDifference(startKey, endKey) < INSIGHTS_MAX_RANGE_DAYS) {
        return { from: start, to: end };
      }
      const firstAllowedKey = addCalendarDaysToKey(endKey, -(INSIGHTS_MAX_RANGE_DAYS - 1));
      return { from: startOfZonedDate(firstAllowedKey, timeZone), to: end };
    }
  }

  const days = rangeDays[range as keyof typeof rangeDays] ?? rangeDays[defaultRange];
  return { from: new Date(now.getTime() - days * dayMs), to: now };
}

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== '';
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const conversationOwnerKey = ({ conversationId, userId }: InsightsConversationOwner): string =>
  JSON.stringify([conversationId, userId]);

const addDay = (days: Map<string, TInsightsDailyPoint>, date: string): TInsightsDailyPoint => {
  const current = days.get(date) ?? {
    date,
    conversations: 0,
    users: 0,
    messages: 0,
    totalTokens: 0,
  };
  days.set(date, current);
  return current;
};

const toUser = (
  userId: string,
  conversations: number,
  users: Map<string, InsightsUserSummary>,
  messageSummary: UserMessageTotals | undefined,
): TInsightsUser => {
  const user = users.get(userId);
  return {
    userId,
    name: user?.name || user?.username || '',
    email: user?.email ?? '',
    conversations,
    messages: messageSummary?.messages ?? 0,
  };
};

/** The scope of a report for the options. */
export function resolveInsightsScope(options: InsightsOptions): InsightsScope {
  const page = Math.max(1, Math.floor(options.page ?? 1));
  const pageSize = Math.min(50, Math.max(5, Math.floor(options.pageSize ?? 10)));
  const agentIds = [...new Set(options.agentIds ?? [])].sort((a, b) => a.localeCompare(b));
  const { from, to } = resolveRange(options);
  const timeZone = validTimeZone(options.timeZone);
  const churnedCutoff = new Date(to.getTime() - churnedUserWindowDays * dayMs);
  const churnedActivityFrom = new Date(from.getTime() - churnedUserWindowDays * dayMs);
  const requestedSearch = options.search?.trim().slice(0, INSIGHTS_SEARCH_MAX_LENGTH) ?? '';
  const search = requestedSearch.length >= INSIGHTS_SEARCH_MIN_LENGTH ? requestedSearch : '';
  const searchRegex = search ? new RegExp(escapeRegex(search), 'i') : undefined;
  return {
    agentIds,
    tenantId: options.tenantId,
    timeZone,
    from,
    to,
    churnedCutoff,
    churnedActivityFrom,
    search,
    searchRegex,
    page,
    pageSize,
  };
}

/** The report for the options, from the aggregates `steps` computes. */
export async function getInsightsWith(
  steps: InsightsSteps,
  options: InsightsOptions = {},
): Promise<InsightsResult> {
  const scope = resolveInsightsScope(options);
  const { from, to, timeZone, searchRegex, page, pageSize } = scope;

  const [
    conversationDays,
    latestRows,
    searchedConversationCount,
    messageDays,
    userCount,
    dailyUsers,
    topMessageUsers,
    churnedUserRows,
  ] = await Promise.all([
    steps.conversationDays(scope),
    steps.latestConversations(scope),
    searchRegex ? steps.searchedConversationCount(scope) : Promise.resolve(0),
    steps.messageDays(scope),
    steps.userCount(scope),
    steps.dailyUsers(scope),
    steps.topMessageUsers(scope),
    steps.churnedUsers(scope),
  ]);

  const latestConversationOwners = latestRows
    .filter(
      (row): row is InsightsRecentConversation & { userId: string } =>
        isNonEmptyString(row.conversationId) && isNonEmptyString(row.userId),
    )
    .map(({ conversationId, userId }) => ({ conversationId, userId }));
  const latest: InsightsLatestConversations = {
    conversationIds: [
      ...new Set(latestConversationOwners.map(({ conversationId }) => conversationId)),
    ],
    owners: latestConversationOwners,
  };
  const topUserIds = topMessageUsers.map(({ _id }) => _id);
  const churnedUserIds = churnedUserRows.map(({ _id }) => _id);
  const userIds = new Set<string>([
    ...topUserIds,
    ...churnedUserIds,
    ...latestRows.map(({ userId }) => userId).filter(isNonEmptyString),
  ]);

  const [
    latestMessageSummaries,
    firstMessages,
    topConversationCounts,
    churnedUserSummaries,
    userRows,
  ] = await Promise.all([
    latest.owners.length === 0
      ? Promise.resolve([] as InsightsConversationMessageSummary[])
      : steps.latestMessageSummaries(scope, latest),
    latest.owners.length === 0
      ? Promise.resolve([] as InsightsFirstMessage[])
      : steps.firstMessages(scope, latest),
    topUserIds.length === 0
      ? Promise.resolve([] as InsightsUserConversationCount[])
      : steps.topConversationCounts(scope, topUserIds),
    churnedUserIds.length === 0
      ? Promise.resolve([] as InsightsChurnedUserSummary[])
      : steps.churnedUserSummaries(scope, churnedUserIds),
    userIds.size === 0
      ? Promise.resolve([] as InsightsUserSummary[])
      : steps.users(scope, [...userIds]),
  ]);

  const users = new Map(userRows.map((user) => [user._id.toString(), user]));
  const agentNames = new Map((options.agents ?? []).map((agent) => [agent.id, agent.name]));
  const latestSummaries = new Map(
    latestMessageSummaries.map((summary) => [conversationOwnerKey(summary._id), summary]),
  );
  const firstByConversation = new Map(
    firstMessages.map((message) => [conversationOwnerKey(message._id), message.text]),
  );
  const days = new Map<string, TInsightsDailyPoint>();
  const firstDay = insightsDateKey(from, timeZone);
  const lastDay = insightsDateKey(to, timeZone);
  for (let key = firstDay; key <= lastDay; key = addCalendarDaysToKey(key, 1)) {
    addDay(days, key);
  }
  for (const row of conversationDays) addDay(days, row.date).conversations = row.conversations;
  for (const row of messageDays) {
    const day = addDay(days, row.date);
    day.messages = row.messages;
    day.totalTokens = row.totalTokens;
  }
  for (const row of dailyUsers) addDay(days, row.date).users = row.users;

  const totalConversations = conversationDays.reduce((total, row) => total + row.conversations, 0);
  const matchingConversations = searchRegex ? searchedConversationCount : totalConversations;
  const topConversationCountsByUser = new Map(
    topConversationCounts.map((summary) => [summary._id, summary.conversations]),
  );
  const churnedSummariesByUser = new Map(
    churnedUserSummaries.map((summary) => [summary._id, summary]),
  );

  return {
    agents: options.agents ?? [],
    summary: {
      totalUsers: userCount,
      totalConversations,
      totalMessages: messageDays.reduce((total, row) => total + row.messages, 0),
      totalTokens: messageDays.reduce((total, row) => total + row.totalTokens, 0),
    },
    daily: [...days.values()].sort((left, right) => left.date.localeCompare(right.date)),
    topUsers: topMessageUsers.map((row) =>
      toUser(row._id, topConversationCountsByUser.get(row._id) ?? 0, users, row),
    ),
    churnedUsers: churnedUserRows.map((row): TInsightsChurnedUser => {
      const user = users.get(row._id);
      const summary = churnedSummariesByUser.get(row._id);
      return {
        userId: row._id,
        name: user?.name || user?.username || '',
        email: user?.email ?? '',
        conversations: summary?.conversations ?? 0,
        messages: summary?.messages ?? 0,
        firstSeen: summary?.firstSeen.toISOString() ?? row.lastSeen.toISOString(),
        lastSeen: row.lastSeen.toISOString(),
      };
    }),
    latest: {
      conversations: latestRows.map((row): TInsightsConversation => {
        const userId = isNonEmptyString(row.userId) ? row.userId : '';
        const user = userId ? users.get(userId) : undefined;
        const ownerKey = conversationOwnerKey({ conversationId: row.conversationId, userId });
        const summary = latestSummaries.get(ownerKey);
        return {
          ...row,
          agentName: agentNames.get(row.agentId) ?? row.agentId,
          userId,
          date: row.date.toISOString(),
          name: user?.name || user?.username || '',
          email: user?.email ?? '',
          firstMessage: firstByConversation.get(ownerKey) ?? '',
          messages: summary?.messages ?? 0,
          totalTokens: summary?.totalTokens ?? 0,
        };
      }),
      page,
      pageSize,
      pages: Math.max(1, Math.ceil(matchingConversations / pageSize)),
    },
  };
}
