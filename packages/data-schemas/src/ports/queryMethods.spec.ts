import type { ConversationTagMethods } from '~/methods/conversationTag';
import type { TransactionMethods } from '~/methods/transaction';
import type { TokenTransactionStore } from './tokenTransaction';
import type { ConversationTagStore } from './conversationTag';
import type { AssistantMethods } from '~/methods/assistant';
import type { UserGroupMethods } from '~/methods/userGroup';
import type { MCPServerMethods } from '~/methods/mcpServer';
import type { ScheduleMethods } from '~/methods/schedule';
import type { PromptLibraryStore } from './promptLibrary';
import type { MessageMethods } from '~/methods/message';
import type { Assert, Satisfies } from './conformance';
import type { PresetMethods } from '~/methods/preset';
import type { PromptMethods } from '~/methods/prompt';
import type { AgentMethods } from '~/methods/agent';
import type { TokenMethods } from '~/methods/token';
import type { UserMethods } from '~/methods/user';
import type { RoleMethods } from '~/methods/role';
import type { FileMethods } from '~/methods/file';
import type { AssistantStore } from './assistant';
import type { MCPServerStore } from './mcpServer';
import type { UserGroupStore } from './userGroup';
import type { ScheduleStore } from './schedule';
import type { MessageStore } from './message';
import type { PresetStore } from './preset';
import type { AgentStore } from './agent';
import type { TokenStore } from './token';
import type { UserStore } from './user';
import type { RoleStore } from './role';
import type { FileStore } from './file';

/**
 * The port methods that state criteria, projections or paging in the store query language
 * (`./query`), checked strictly: the port specs compare method signatures, whose parameters
 * TypeScript checks in either direction, so they would also pass if the MongoDB method accepted
 * less than the port lets a caller pass. Restated here as function-typed properties, whose
 * parameters are checked one way only: the MongoDB method must accept every filter, projection
 * and option the port admits.
 */
type Strict<Port> = {
  [K in keyof Port]: Port[K] extends (...args: infer A) => infer R ? (...args: A) => R : never;
};

type UserQueryMethods = Pick<
  UserStore,
  'findUser' | 'findUsers' | 'countUsers' | 'updateUser' | 'getUserById' | 'searchUsers'
>;
type RoleQueryMethods = Pick<RoleStore, 'getRoleByName' | 'findRolesByNames'>;
type MCPServerQueryMethods = Pick<MCPServerStore, 'getListMCPServersByIds'>;
type MessageQueryMethods = Pick<MessageStore, 'getMessages' | 'deleteMessages'>;
type FileQueryMethods = Pick<
  FileStore,
  'findFileById' | 'getFiles' | 'updateFile' | 'deleteFileByFilter'
>;
type AgentQueryMethods = Pick<
  AgentStore,
  | 'getAgent'
  | 'getAgents'
  | 'getAgentVersions'
  | 'getAgentWithVersionCount'
  | 'updateAgent'
  | 'deleteAgent'
  | 'revertAgentVersion'
  | 'getListAgentsByAccess'
>;

/**
 * The first of two overloads of `F`. `Strict` infers from the last overload only, so the
 * one-argument `getAgent` is checked through this.
 */
type FirstOverload<F> = F extends {
  (...args: infer A): infer R;
  (...args: infer _B): unknown;
}
  ? (...args: A) => R
  : never;
type AgentGetAgentFirstOverload = { getAgent: FirstOverload<AgentStore['getAgent']> };

type PresetQueryMethods = Pick<PresetStore, 'getPresets' | 'deletePresets'>;
type AssistantQueryMethods = Pick<AssistantStore, 'getAssistant' | 'getAssistants'>;
type TokenTransactionQueryMethods = Pick<
  TokenTransactionStore,
  'getTransactions' | 'deleteTransactions' | 'deleteBalances'
>;
type PromptLibraryQueryMethods = Pick<
  PromptLibraryStore,
  | 'getPromptGroups'
  | 'getAllPromptGroups'
  | 'getPromptGroup'
  | 'updatePromptGroup'
  | 'getPrompts'
  | 'getPrompt'
>;
type ConversationTagQueryMethods = Pick<ConversationTagStore, 'deleteConversationTags'>;
type UserGroupQueryMethods = Pick<UserGroupStore, 'findGroupByQuery' | 'bulkUpdateGroups'>;

/**
 * Whether the MongoDB method `K` of `Impl` accepts every value the port's method `K` admits as
 * its parameter `I`, checked one way. For the query-language parameters of methods whose other
 * parameters state ids as `IdLike`, which the port specs check (bivariantly, as everywhere) and
 * `Strict` would reject.
 */
type AcceptsParam<
  Port,
  Impl,
  K extends keyof Port & keyof Impl,
  I extends number,
> = Port[K] extends (...args: infer P) => unknown
  ? Impl[K] extends (...args: infer Q) => unknown
    ? [P[I]] extends [Q[I]]
      ? true
      : false
    : false
  : false;

/* Type-level conformance (see `./conformance`): fails `npm run typecheck`, not Jest. */
type Checks = [
  Assert<Satisfies<Strict<UserQueryMethods>, UserMethods>>,
  Assert<Satisfies<Strict<RoleQueryMethods>, RoleMethods>>,
  Assert<Satisfies<Strict<MCPServerQueryMethods>, MCPServerMethods>>,
  Assert<Satisfies<Strict<MessageQueryMethods>, MessageMethods>>,
  Assert<Satisfies<Strict<FileQueryMethods>, FileMethods>>,
  Assert<Satisfies<Strict<AgentQueryMethods>, AgentMethods>>,
  Assert<Satisfies<AgentGetAgentFirstOverload, AgentMethods>>,
  Assert<Satisfies<Strict<PresetQueryMethods>, PresetMethods>>,
  Assert<Satisfies<Strict<AssistantQueryMethods>, AssistantMethods>>,
  Assert<Satisfies<Strict<TokenTransactionQueryMethods>, TransactionMethods>>,
  Assert<Satisfies<Strict<PromptLibraryQueryMethods>, PromptMethods>>,
  Assert<Satisfies<Strict<ConversationTagQueryMethods>, ConversationTagMethods>>,
  Assert<Satisfies<Strict<UserGroupQueryMethods>, UserGroupMethods>>,
  Assert<AcceptsParam<TokenStore, TokenMethods, 'findToken', 1>>,
  Assert<AcceptsParam<UserGroupStore, UserGroupMethods, 'findGroupById', 1>>,
  Assert<AcceptsParam<UserGroupStore, UserGroupMethods, 'findGroupByExternalId', 1>>,
  Assert<AcceptsParam<UserGroupStore, UserGroupMethods, 'findGroupByExternalId', 2>>,
  Assert<AcceptsParam<UserGroupStore, UserGroupMethods, 'updateGroupById', 1>>,
  Assert<AcceptsParam<ScheduleStore, ScheduleMethods, 'updateScheduleById', 2>>,
  Assert<AcceptsParam<ScheduleStore, ScheduleMethods, 'updateScheduleById', 3>>,
  Assert<AcceptsParam<ScheduleStore, ScheduleMethods, 'updateScheduleById', 4>>,
  Assert<Satisfies<Strict<Pick<ScheduleStore, 'disableSchedule'>>, ScheduleMethods>>,
];

describe('query-language port methods', () => {
  it('are satisfied strictly by the MongoDB methods (type level)', () => {
    // Each `Assert` above fails to compile when its check does not hold.
    const allHold: Checks[number] = true;
    expect(allHold).toBe(true);
  });
});
