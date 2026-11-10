import type { MCPServerMethods } from '~/methods/mcpServer';
import type { MessageMethods } from '~/methods/message';
import type { Assert, Satisfies } from './conformance';
import type { UserMethods } from '~/methods/user';
import type { RoleMethods } from '~/methods/role';
import type { FileMethods } from '~/methods/file';
import type { MCPServerStore } from './mcpServer';
import type { MessageStore } from './message';
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

/* Type-level conformance (see `./conformance`): fails `npm run typecheck`, not Jest. */
type Checks = [
  Assert<Satisfies<Strict<UserQueryMethods>, UserMethods>>,
  Assert<Satisfies<Strict<RoleQueryMethods>, RoleMethods>>,
  Assert<Satisfies<Strict<MCPServerQueryMethods>, MCPServerMethods>>,
  Assert<Satisfies<Strict<MessageQueryMethods>, MessageMethods>>,
  Assert<Satisfies<Strict<FileQueryMethods>, FileMethods>>,
];

describe('query-language port methods', () => {
  it('are satisfied strictly by the MongoDB methods (type level)', () => {
    const typeChecks: Checks = [true, true, true, true, true];
    expect(typeChecks).toEqual([true, true, true, true, true]);
  });
});
