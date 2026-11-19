/* eslint-disable jest/no-export -- This file is a shared contract-test suite, not a
   spec: it exports the suite factory that each backend's own spec imports. The rule
   guards against accidental exports from spec files. */
/**
 * The `UserGroupStore` contract (`~/ports/userGroup`), ported from `methods/userGroup.spec.ts`,
 * `methods/userGroup.methods.spec.ts` and `methods/userGroup.roles.spec.ts`: group reads by id,
 * external id, query and word-prefix name search, creation and upserts by external id, the
 * membership writes (member keys are a user's external id, else its id) and what each reports,
 * tracked field updates, bulk updates in the store query language, the principals a user acts
 * as, principal search across users, groups and roles, listings and deletes, and the membership
 * cache every membership change drops (with a fake cache store). Groups and users that a search
 * must find are created through the stores, which write their search tokens. The cache's
 * internals (build deduplication, locks, cross-process second passes, transaction-deferred
 * invalidation, primary reads) and the pure ranking helpers stay in the method specs. Nothing
 * here may import `mongoose` or the MongoDB driver.
 */
import { CacheKeys, PrincipalType, SystemRoles } from 'librechat-data-provider';
import type { ContractHarness, RawRecord } from './harness';
import type { CacheStore, IGroup } from '~/types';
import { idOf, readRawWhere, timeOf, useContractHarness } from './support';

/** A `Map`-backed cache store with `delete` and `clear`, as membership invalidation uses. */
function fakeCache(): CacheStore & { entries: Map<string, unknown> } {
  const entries = new Map<string, unknown>();
  return {
    entries,
    get: async (key) => entries.get(key),
    set: async (key, value) => entries.set(key, value),
    delete: async (key) => entries.delete(key),
    clear: async () => entries.clear(),
  };
}

export function describeUserGroupContract(harness: ContractHarness): void {
  describe(`UserGroupStore contract: ${harness.name}`, () => {
    useContractHarness(harness);

    const stores = () => harness.createStores().userGroups;
    /** The group store with a fake membership cache. */
    const cachedStores = () => {
      const cache = fakeCache();
      const { userGroups } = harness.createStores({
        getCache: (key) => (key === CacheKeys.USER_PRINCIPALS ? cache : undefined),
      });
      return { userGroups, cache };
    };
    /** Seeds a group raw and resolves its id. */
    const seedGroup = async (record: RawRecord): Promise<string> => {
      const _id = harness.ids.generate();
      await harness.seedRaw('groups', [{ _id, source: 'local', memberIds: [], ...record }]);
      return _id;
    };
    /** Seeds a user raw and resolves its id. */
    const seedUser = async (record: RawRecord = {}): Promise<string> => {
      const _id = harness.ids.generate();
      await harness.seedRaw('users', [
        { _id, email: `${_id}@example.com`, provider: 'local', ...record },
      ]);
      return _id;
    };
    /** Creates a user through the user store (with its search tokens) and resolves its id. */
    const createUser = async (data: RawRecord): Promise<string> =>
      idOf(
        harness,
        await harness.createStores().users.createUser({ provider: 'local', ...data } as never),
      );
    const memberIdsOf = async (groupId: string) =>
      (await readRawWhere(harness, 'groups', { _id: groupId }))[0]?.memberIds as
        | string[]
        | undefined;
    const names = (groups: Array<{ name?: string }>) => groups.map(({ name }) => name).sort();
    const groupIdsOf = (principals: Array<{ principalType: string; principalId?: unknown }>) =>
      principals
        .filter(({ principalType }) => principalType === PrincipalType.GROUP)
        .map(({ principalId }) => idOf(harness, principalId))
        .sort();

    describe('findGroupById', () => {
      it('finds a group by its id in either form, and null for an unknown one', async () => {
        const groupId = await seedGroup({ name: 'Team', description: 'desc', email: 't@x.com' });
        const found = await stores().findGroupById(groupId);
        expect(idOf(harness, found?._id)).toBe(groupId);
        expect(found).toMatchObject({ name: 'Team', description: 'desc', source: 'local' });
        expect(
          idOf(harness, (await stores().findGroupById(harness.ids.toStoreId(groupId)))?._id),
        ).toBe(groupId);
        expect(await stores().findGroupById(harness.ids.generate())).toBeNull();
      });

      it('applies the projection', async () => {
        const groupId = await seedGroup({ name: 'Team', description: 'desc', email: 't@x.com' });
        const projected = await stores().findGroupById(groupId, { name: 1 });
        expect(projected?.name).toBe('Team');
        expect(projected).not.toHaveProperty('description');
        expect(projected).not.toHaveProperty('email');
        const excluded = await stores().findGroupById(groupId, { description: 0 });
        expect(excluded).not.toHaveProperty('description');
        expect(excluded?.email).toBe('t@x.com');
      });
    });

    describe('findGroupByExternalId', () => {
      it('finds a group by external id and source, entra by default', async () => {
        await seedGroup({ name: 'Entra', source: 'entra', idOnTheSource: 'ext-1' });
        await seedGroup({ name: 'Local', source: 'local', idOnTheSource: 'ext-1' });
        expect((await stores().findGroupByExternalId('ext-1'))?.name).toBe('Entra');
        expect((await stores().findGroupByExternalId('ext-1', 'local'))?.name).toBe('Local');
        expect(await stores().findGroupByExternalId('ext-2')).toBeNull();
        expect(
          await stores().findGroupByExternalId('ext-1', 'local', { name: 1 }),
        ).not.toHaveProperty('source');
      });
    });

    describe('findGroupsByExternalIds', () => {
      it('reads the groups of the source with only their external id', async () => {
        await seedGroup({ name: 'A', source: 'entra', idOnTheSource: 'ext-a' });
        await seedGroup({ name: 'B', source: 'entra', idOnTheSource: 'ext-b' });
        await seedGroup({ name: 'L', source: 'local', idOnTheSource: 'ext-c' });
        const found = await stores().findGroupsByExternalIds(['ext-a', 'ext-c', 'ext-z']);
        expect(found).toEqual([{ idOnTheSource: 'ext-a' }]);
        expect(await stores().findGroupsByExternalIds(['ext-c'], 'local')).toEqual([
          { idOnTheSource: 'ext-c' },
        ]);
        expect(await stores().findGroupsByExternalIds([])).toEqual([]);
      });
    });

    describe('findGroupByQuery', () => {
      it('finds the first group matching the criteria, or null', async () => {
        await seedGroup({ name: 'Target', email: 'target@co.com' });
        expect((await stores().findGroupByQuery({ email: 'target@co.com' }))?.name).toBe('Target');
        expect(await stores().findGroupByQuery({ name: 'Nonexistent' })).toBeNull();
      });
    });

    describe('findGroupsByNamePattern', () => {
      const createGroups = async () => {
        for (const group of [
          { name: 'Engineering', source: 'local', description: 'Eng team' },
          { name: 'Design', source: 'local', email: 'design@co.com' },
          { name: 'Entra Eng', source: 'entra', idOnTheSource: 'ext-1' },
          { name: 'Literal .* Group', source: 'local' },
        ] as Partial<IGroup>[]) {
          await stores().createGroup(group);
        }
      };

      it('matches words of the name or email by prefix, ignoring case', async () => {
        await createGroups();
        expect(names(await stores().findGroupsByNamePattern('eng'))).toEqual([
          'Engineering',
          'Entra Eng',
        ]);
        expect(names(await stores().findGroupsByNamePattern('design@'))).toEqual(['Design']);
        expect(names(await stores().findGroupsByNamePattern('ENTRA eng'))).toEqual(['Entra Eng']);
      });

      it('never matches the description, or a word inside another word', async () => {
        await createGroups();
        expect(await stores().findGroupsByNamePattern('Eng team')).toEqual([]);
        expect(await stores().findGroupsByNamePattern('neering')).toEqual([]);
      });

      it('treats pattern metacharacters as literal text, and a blank pattern as nothing', async () => {
        await createGroups();
        expect(await stores().findGroupsByNamePattern('.*')).toEqual([]);
        expect(names(await stores().findGroupsByNamePattern('literal'))).toEqual([
          'Literal .* Group',
        ]);
        expect(await stores().findGroupsByNamePattern('   ')).toEqual([]);
      });

      it('filters by source and limits the results, 20 by default', async () => {
        await createGroups();
        expect(names(await stores().findGroupsByNamePattern('eng', 'entra'))).toEqual([
          'Entra Eng',
        ]);
        for (let index = 0; index < 22; index++) {
          await stores().createGroup({ name: `Numbered Group ${index}`, source: 'local' });
        }
        expect(await stores().findGroupsByNamePattern('Numbered', null, 2)).toHaveLength(2);
        expect(await stores().findGroupsByNamePattern('Numbered')).toHaveLength(20);
      });

      it('finds a group whose name a later update changed', async () => {
        const group = await stores().createGroup({ name: 'Old Name', source: 'local' });
        await stores().updateGroupById(idOf(harness, group._id), { name: 'Platform Team' });
        expect(names(await stores().findGroupsByNamePattern('platform'))).toEqual([
          'Platform Team',
        ]);
        expect(await stores().findGroupsByNamePattern('old')).toEqual([]);
      });
    });

    describe('createGroup', () => {
      it('creates the group with its defaults and resolves it as stored', async () => {
        const group = await stores().createGroup({ name: 'Minimal' });
        const groupId = idOf(harness, group._id);
        expect(group).toMatchObject({ name: 'Minimal', source: 'local' });
        const stored = (await readRawWhere(harness, 'groups', { _id: groupId }))[0];
        expect(stored).toMatchObject({ name: 'Minimal', source: 'local', memberIds: [] });
        expect(stored.createdAt).toBeInstanceOf(Date);
      });

      it('stores every given field', async () => {
        const group = await stores().createGroup({
          name: 'Full',
          description: 'All fields',
          email: 'full@co.com',
          avatar: 'a.png',
          source: 'entra',
          idOnTheSource: 'ext-full',
          memberIds: ['m1', 'm2'],
        });
        expect(
          (await readRawWhere(harness, 'groups', { _id: idOf(harness, group._id) }))[0],
        ).toMatchObject({
          description: 'All fields',
          email: 'full@co.com',
          avatar: 'a.png',
          source: 'entra',
          idOnTheSource: 'ext-full',
          memberIds: ['m1', 'm2'],
        });
      });

      it('refuses a second group with the same external id and source', async () => {
        await stores().createGroup({ name: 'A', source: 'entra', idOnTheSource: 'ext-1' });
        const failure = await stores()
          .createGroup({ name: 'B', source: 'entra', idOnTheSource: 'ext-1' })
          .then(
            () => undefined,
            (error: unknown) => error,
          );
        expect(harness.errors.isDuplicateKey(failure)).toBe(true);
        await expect(
          stores().createGroup({ name: 'C', source: 'local', idOnTheSource: 'ext-1' }),
        ).resolves.toBeDefined();
      });
    });

    describe('upsertGroupByExternalId', () => {
      it('creates the group when none exists, and updates it after', async () => {
        const created = await stores().upsertGroupByExternalId('ext-1', 'entra', {
          name: 'Synced',
          email: 'synced@co.com',
        });
        expect(created).toMatchObject({
          name: 'Synced',
          source: 'entra',
          idOnTheSource: 'ext-1',
        });
        const updated = await stores().upsertGroupByExternalId('ext-1', 'entra', {
          name: 'Renamed',
        });
        expect(idOf(harness, updated?._id)).toBe(idOf(harness, created?._id));
        expect(updated).toMatchObject({ name: 'Renamed', email: 'synced@co.com' });
        expect(await harness.readRaw('groups')).toHaveLength(1);
      });

      it('never updates the group of another source', async () => {
        const local = await seedGroup({ name: 'Local', source: 'local', idOnTheSource: 'ext-1' });
        await stores().upsertGroupByExternalId('ext-1', 'entra', { name: 'Entra' });
        expect((await readRawWhere(harness, 'groups', { _id: local }))[0].name).toBe('Local');
        expect(await harness.readRaw('groups')).toHaveLength(2);
      });

      it('replaces the members and resolves the group as stored', async () => {
        await seedGroup({
          name: 'Team',
          source: 'entra',
          idOnTheSource: 'ext-1',
          memberIds: ['old'],
        });
        const updated = await stores().upsertGroupByExternalId('ext-1', 'entra', {
          memberIds: ['new-1', 'new-2'],
        });
        expect(updated?.memberIds).toEqual(['new-1', 'new-2']);
        const created = await stores().upsertGroupByExternalId('ext-2', 'entra', {
          name: 'Created',
          memberIds: ['m'],
        });
        expect(created).toMatchObject({ name: 'Created', memberIds: ['m'] });
      });

      it('creates one group when concurrent upserts race', async () => {
        const results = await Promise.allSettled(
          Array.from({ length: 4 }, (_, index) =>
            stores().upsertGroupByExternalId('ext-race', 'entra', { name: `Race ${index}` }),
          ),
        );
        const stored = await harness.readRaw('groups');
        expect(stored).toHaveLength(1);
        const resolvedIds = results.flatMap((result) =>
          result.status === 'fulfilled' ? [idOf(harness, result.value?._id)] : [],
        );
        const failures = results.flatMap((result) =>
          result.status === 'rejected' ? [result.reason] : [],
        );
        expect(resolvedIds.length).toBeGreaterThan(0);
        expect(new Set(resolvedIds)).toEqual(new Set([stored[0]._id]));
        // NOTE(contract): the port promises an upsert safe against a concurrent create, but the
        // MongoDB upsert's filter does not cover the unique index (it has `tenantId` too), so
        // the server does not retry it, and a losing call may reject with the duplicate-key
        // error instead of updating the group the winner created.
        expect(failures.every((failure) => harness.errors.isDuplicateKey(failure))).toBe(true);
      });
    });

    describe('addUserToGroup and removeUserFromGroup', () => {
      it("adds the user's external id as member key, reporting the change once", async () => {
        const userId = await seedUser({ idOnTheSource: 'ext-user' });
        const groupId = await seedGroup({ name: 'Team' });
        const first = await stores().addUserToGroup(userId, groupId);
        expect(first.changed).toBe(true);
        expect(idOf(harness, first.user._id)).toBe(userId);
        expect(first.user.idOnTheSource).toBe('ext-user');
        expect(first.group?.memberIds).toEqual(['ext-user']);
        const second = await stores().addUserToGroup(harness.ids.toStoreId(userId), groupId);
        expect(second.changed).toBe(false);
        expect(second.group?.memberIds).toEqual(['ext-user']);
        expect(await memberIdsOf(groupId)).toEqual(['ext-user']);
      });

      it('falls back to the user id as member key', async () => {
        const userId = await seedUser();
        const groupId = await seedGroup({ name: 'Team' });
        await stores().addUserToGroup(userId, groupId);
        expect(await memberIdsOf(groupId)).toEqual([userId]);
      });

      it('removes the member key, reporting the change once', async () => {
        const userId = await seedUser({ idOnTheSource: 'ext-user' });
        const groupId = await seedGroup({ name: 'Team', memberIds: ['ext-user', 'other'] });
        const first = await stores().removeUserFromGroup(userId, groupId);
        expect(first.changed).toBe(true);
        expect(first.group?.memberIds).toEqual(['other']);
        const second = await stores().removeUserFromGroup(userId, groupId);
        expect(second.changed).toBe(false);
        expect(second.group?.memberIds).toEqual(['other']);
      });

      it('resolves a null group for an unknown group', async () => {
        const userId = await seedUser();
        const added = await stores().addUserToGroup(userId, harness.ids.generate());
        expect(added).toMatchObject({ group: null, changed: false });
        const removed = await stores().removeUserFromGroup(userId, harness.ids.generate());
        expect(removed).toMatchObject({ group: null, changed: false });
      });

      it('throws for an unknown user', async () => {
        const groupId = await seedGroup({ name: 'Team' });
        await expect(stores().addUserToGroup(harness.ids.generate(), groupId)).rejects.toThrow(
          'User not found',
        );
        await expect(stores().removeUserFromGroup(harness.ids.generate(), groupId)).rejects.toThrow(
          'User not found',
        );
        expect(await memberIdsOf(groupId)).toEqual([]);
      });

      it('reports exactly one change for concurrent additions of one user', async () => {
        const userId = await seedUser();
        const groupId = await seedGroup({ name: 'Team' });
        const results = await Promise.all(
          Array.from({ length: 5 }, () => stores().addUserToGroup(userId, groupId)),
        );
        expect(results.filter(({ changed }) => changed)).toHaveLength(1);
        expect(await memberIdsOf(groupId)).toEqual([userId]);
      });
    });

    describe('removeUserFromAllGroups', () => {
      it('removes the member key from every group that lists it', async () => {
        const userId = harness.ids.generate();
        const first = await seedGroup({ name: 'A', memberIds: [userId, 'other'] });
        const second = await seedGroup({ name: 'B', memberIds: [userId] });
        const untouched = await seedGroup({ name: 'C', memberIds: ['other'] });
        await stores().removeUserFromAllGroups(userId);
        expect(await memberIdsOf(first)).toEqual(['other']);
        expect(await memberIdsOf(second)).toEqual([]);
        expect(await memberIdsOf(untouched)).toEqual(['other']);
        await expect(stores().removeUserFromAllGroups(userId)).resolves.toBeUndefined();
      });
    });

    describe('updateGroupById', () => {
      it('sets the fields and resolves the group updated, or null', async () => {
        const groupId = await seedGroup({ name: 'Old Name', description: 'kept' });
        const updated = await stores().updateGroupById(groupId, { name: 'New Name' });
        expect(updated).toMatchObject({ name: 'New Name', description: 'kept' });
        expect(await stores().updateGroupById(harness.ids.generate(), { name: 'X' })).toBeNull();
      });

      it('replaces the members', async () => {
        const groupId = await seedGroup({ name: 'Team', memberIds: ['old'] });
        const updated = await stores().updateGroupById(groupId, { memberIds: ['new'] });
        expect(updated?.memberIds).toEqual(['new']);
        expect(await memberIdsOf(groupId)).toEqual(['new']);
        expect(
          await stores().updateGroupById(harness.ids.generate(), { memberIds: ['x'] }),
        ).toBeNull();
        expect(await harness.readRaw('groups')).toHaveLength(1);
      });
    });

    describe('bulkUpdateGroups', () => {
      it('updates every matching group and counts them', async () => {
        await seedGroup({ name: 'A', source: 'entra', idOnTheSource: 'ext-a' });
        await seedGroup({ name: 'B', source: 'entra', idOnTheSource: 'ext-b' });
        await seedGroup({ name: 'C', source: 'local' });
        const result = await stores().bulkUpdateGroups(
          { source: 'entra' },
          { $set: { description: 'synced' } },
        );
        expect(result).toMatchObject({ matchedCount: 2, modifiedCount: 2 });
        expect(await readRawWhere(harness, 'groups', { description: 'synced' })).toHaveLength(2);
        expect(
          await stores().bulkUpdateGroups(
            { source: 'none' as never },
            { $set: { description: 'x' } },
          ),
        ).toMatchObject({ matchedCount: 0, modifiedCount: 0 });
      });

      it('adds and removes member keys with $addToSet and $pullAll', async () => {
        const first = await seedGroup({ name: 'A', memberIds: ['m1'] });
        const second = await seedGroup({ name: 'B', memberIds: ['m2'] });
        const added = await stores().bulkUpdateGroups(
          { _id: { $in: [first, second] } },
          { $addToSet: { memberIds: 'm1' } },
        );
        /** The update time is stamped on every matched group, so both count as modified. */
        expect(added).toMatchObject({ matchedCount: 2, modifiedCount: 2 });
        expect(await memberIdsOf(first)).toEqual(['m1']);
        expect(await memberIdsOf(second)).toEqual(['m2', 'm1']);
        await stores().bulkUpdateGroups({ _id: second }, { $pullAll: { memberIds: ['m1', 'm2'] } });
        expect(await memberIdsOf(second)).toEqual([]);
      });
    });

    describe('updateGroupFieldsTracked', () => {
      it('reports whether a value changed and which fields did', async () => {
        const groupId = await seedGroup({ name: 'Team', description: 'one', email: 'a@x.com' });
        const changed = await stores().updateGroupFieldsTracked(groupId, {
          name: 'Team',
          description: 'two',
        });
        expect(changed).toMatchObject({ changed: true, changedFields: ['description'] });
        expect(changed?.group).toMatchObject({ name: 'Team', description: 'two' });
        const unchanged = await stores().updateGroupFieldsTracked(groupId, { description: 'two' });
        expect(unchanged).toMatchObject({ changed: false, changedFields: [] });
        expect(unchanged?.group.description).toBe('two');
      });

      it('writes nothing for empty data, and resolves null for an unknown group', async () => {
        const groupId = await seedGroup({ name: 'Team' });
        const before = await harness.readRaw('groups');
        expect(await stores().updateGroupFieldsTracked(groupId, {})).toMatchObject({
          changed: false,
          changedFields: [],
          group: { name: 'Team' },
        });
        expect(await harness.readRaw('groups')).toEqual(before);
        expect(await stores().updateGroupFieldsTracked(harness.ids.generate(), {})).toBeNull();
        expect(
          await stores().updateGroupFieldsTracked(harness.ids.generate(), { name: 'x' }),
        ).toBeNull();
      });

      it('reports a field change only for the call that made it when calls race', async () => {
        const groupId = await seedGroup({ name: 'Team' });
        const results = await Promise.all(
          Array.from({ length: 4 }, () =>
            stores().updateGroupFieldsTracked(groupId, { name: 'Renamed' }),
          ),
        );
        expect(results.filter((result) => result?.changed)).toHaveLength(1);
      });

      it('sets a field the group did not have', async () => {
        const groupId = await seedGroup({ name: 'Team' });
        const result = await stores().updateGroupFieldsTracked(groupId, { avatar: 'a.png' });
        expect(result).toMatchObject({ changed: true, changedFields: ['avatar'] });
      });
    });

    describe('getUserPrincipals', () => {
      it('resolves the user, role, groups and public, in that order', async () => {
        const userId = await seedUser({ role: 'EDITOR', idOnTheSource: 'ext-user' });
        const groupA = await seedGroup({ name: 'A', memberIds: ['ext-user'] });
        const groupB = await seedGroup({ name: 'B', memberIds: ['ext-user', 'x'] });
        await seedGroup({ name: 'C', memberIds: [userId] });
        const principals = await stores().getUserPrincipals({ userId });
        expect(principals.map(({ principalType }) => principalType)).toEqual([
          PrincipalType.USER,
          PrincipalType.ROLE,
          PrincipalType.GROUP,
          PrincipalType.GROUP,
          PrincipalType.PUBLIC,
        ]);
        expect(idOf(harness, principals[0].principalId)).toBe(userId);
        expect(principals[1].principalId).toBe('EDITOR');
        expect(groupIdsOf(principals)).toEqual([groupA, groupB].sort());
        expect(principals[4].principalId).toBeUndefined();
      });

      it('keys a local user by user id, given as a string or store id', async () => {
        const userId = await seedUser({ role: SystemRoles.USER });
        const groupId = await seedGroup({ name: 'A', memberIds: [userId] });
        expect(groupIdsOf(await stores().getUserPrincipals({ userId }))).toEqual([groupId]);
        expect(
          groupIdsOf(await stores().getUserPrincipals({ userId: harness.ids.toStoreId(userId) })),
        ).toEqual([groupId]);
      });

      it('uses a given role and idOnTheSource without reading the user', async () => {
        const userId = harness.ids.generate();
        const groupId = await seedGroup({ name: 'A', memberIds: ['given-ext'] });
        const principals = await stores().getUserPrincipals({
          userId,
          role: 'GIVEN',
          idOnTheSource: 'given-ext',
        });
        expect(principals[1]).toEqual({ principalType: PrincipalType.ROLE, principalId: 'GIVEN' });
        expect(groupIdsOf(principals)).toEqual([groupId]);
      });

      it('takes a given idOnTheSource over the stored one, and null as a local user', async () => {
        const userId = await seedUser({ idOnTheSource: 'stored-ext' });
        const supplied = await seedGroup({ name: 'Supplied', memberIds: ['supplied-ext'] });
        await seedGroup({ name: 'Stored', memberIds: ['stored-ext'] });
        const local = await seedGroup({ name: 'Local', memberIds: [userId] });
        expect(
          groupIdsOf(
            await stores().getUserPrincipals({ userId, role: null, idOnTheSource: 'supplied-ext' }),
          ),
        ).toEqual([supplied]);
        expect(
          groupIdsOf(await stores().getUserPrincipals({ userId, role: null, idOnTheSource: null })),
        ).toEqual([local]);
      });

      it('omits the role when it is null, blank or unset', async () => {
        const blank = await seedUser({ role: '   ' });
        const unset = await seedUser();
        const types = (principals: Array<{ principalType: PrincipalType }>) =>
          principals.map(({ principalType }) => principalType);
        expect(
          types(await stores().getUserPrincipals({ userId: harness.ids.generate(), role: null })),
        ).toEqual([PrincipalType.USER, PrincipalType.PUBLIC]);
        expect(types(await stores().getUserPrincipals({ userId: blank }))).toEqual([
          PrincipalType.USER,
          PrincipalType.PUBLIC,
        ]);
        expect(types(await stores().getUserPrincipals({ userId: unset }))).toEqual([
          PrincipalType.USER,
          PrincipalType.PUBLIC,
        ]);
      });

      it('throws for a user id string that is not a valid id', async () => {
        await expect(stores().getUserPrincipals({ userId: 'not-an-id' })).rejects.toThrow();
      });

      it('reads the role a user holds now', async () => {
        const userId = await seedUser({ role: 'EDITOR' });
        expect((await stores().getUserPrincipals({ userId }))[1].principalId).toBe('EDITOR');
        await harness.createStores().roles.updateUsersRoleByIds([userId], 'WRITER');
        expect((await stores().getUserPrincipals({ userId }))[1].principalId).toBe('WRITER');
      });
    });

    describe('the membership cache', () => {
      const principalsOf = (
        userGroups: ReturnType<typeof stores>,
        userId: string,
        idOnTheSource: string,
      ) =>
        userGroups
          .getUserPrincipals({ userId, role: SystemRoles.USER, idOnTheSource })
          .then(groupIdsOf);

      it('serves the same principals from the cache, empty memberships included', async () => {
        const { userGroups, cache } = cachedStores();
        const userId = await seedUser({ idOnTheSource: 'ext-1' });
        const groupId = await seedGroup({ name: 'A', memberIds: ['ext-1'] });
        expect(await principalsOf(userGroups, userId, 'ext-1')).toEqual([groupId]);
        expect(await principalsOf(userGroups, userId, 'ext-1')).toEqual([groupId]);
        expect(await principalsOf(userGroups, userId, 'ext-none')).toEqual([]);
        expect(await principalsOf(userGroups, userId, 'ext-none')).toEqual([]);
        expect(cache.entries.size).toBeGreaterThan(0);
      });

      it('reflects membership changes made through the store at once', async () => {
        const { userGroups } = cachedStores();
        const userId = await seedUser({ idOnTheSource: 'ext-1' });
        const groupId = await seedGroup({ name: 'A' });
        expect(await principalsOf(userGroups, userId, 'ext-1')).toEqual([]);
        await userGroups.addUserToGroup(userId, groupId);
        expect(await principalsOf(userGroups, userId, 'ext-1')).toEqual([groupId]);
        await userGroups.removeUserFromGroup(userId, groupId);
        expect(await principalsOf(userGroups, userId, 'ext-1')).toEqual([]);
        await userGroups.updateGroupById(groupId, { memberIds: ['ext-1'] });
        expect(await principalsOf(userGroups, userId, 'ext-1')).toEqual([groupId]);
        await userGroups.removeMemberById(groupId, 'ext-1');
        expect(await principalsOf(userGroups, userId, 'ext-1')).toEqual([]);
      });

      it('reflects groups created with members, upserted, and deleted', async () => {
        const { userGroups } = cachedStores();
        const userId = await seedUser({ idOnTheSource: 'ext-2' });
        expect(await principalsOf(userGroups, userId, 'ext-2')).toEqual([]);
        const group = await userGroups.createGroup({ name: 'Created', memberIds: ['ext-2'] });
        expect(await principalsOf(userGroups, userId, 'ext-2')).toEqual([idOf(harness, group._id)]);
        await userGroups.deleteGroup(idOf(harness, group._id));
        expect(await principalsOf(userGroups, userId, 'ext-2')).toEqual([]);
        const upserted = await userGroups.upsertGroupByExternalId('grp', 'entra', {
          name: 'Upserted',
          memberIds: ['ext-2'],
        });
        expect(await principalsOf(userGroups, userId, 'ext-2')).toEqual([
          idOf(harness, upserted?._id),
        ]);
      });

      it('reflects bulk membership updates, named or wholesale', async () => {
        const { userGroups } = cachedStores();
        const userId = await seedUser({ idOnTheSource: 'ext-3' });
        const groupId = await seedGroup({ name: 'Bulk', memberIds: ['ext-3'] });
        expect(await principalsOf(userGroups, userId, 'ext-3')).toEqual([groupId]);
        await userGroups.bulkUpdateGroups({ _id: groupId }, { $pullAll: { memberIds: ['ext-3'] } });
        expect(await principalsOf(userGroups, userId, 'ext-3')).toEqual([]);
        await userGroups.bulkUpdateGroups({ _id: groupId }, { $set: { memberIds: ['ext-3'] } });
        expect(await principalsOf(userGroups, userId, 'ext-3')).toEqual([groupId]);
      });

      it('reflects a removal from every group', async () => {
        const { userGroups } = cachedStores();
        const userId = await seedUser();
        const groupId = await seedGroup({ name: 'A', memberIds: [userId] });
        expect(await principalsOf(userGroups, userId, userId)).toEqual([groupId]);
        await userGroups.removeUserFromAllGroups(userId);
        expect(await principalsOf(userGroups, userId, userId)).toEqual([]);
      });
    });

    describe('searchPrincipals', () => {
      const seedSearch = async () => {
        await createUser({
          name: 'Alice Smith',
          email: 'alice@test.com',
          username: 'alice',
          role: SystemRoles.ADMIN,
        });
        await createUser({ name: 'Bob Jones', email: 'bob@test.com', username: 'bob' });
        await stores().createGroup({ name: 'Alpha Team', source: 'local' });
        await stores().createGroup({
          name: 'Beta Team',
          source: 'entra',
          idOnTheSource: 'ext-beta',
          memberIds: ['a', 'b'],
          email: 'beta@team.com',
          description: 'The beta team',
        });
        await harness.seedRaw('roles', [
          { _id: harness.ids.generate(), name: 'ADMIN' },
          { _id: harness.ids.generate(), name: 'moderator' },
          { _id: harness.ids.generate(), name: 'team-lead' },
        ]);
      };

      it('resolves nothing for a blank pattern', async () => {
        await seedSearch();
        expect(await stores().searchPrincipals('')).toEqual([]);
        expect(await stores().searchPrincipals('   ')).toEqual([]);
      });

      it('finds users by word prefix and maps them to search results', async () => {
        await seedSearch();
        const results = await stores().searchPrincipals('alice', 10, [PrincipalType.USER]);
        expect(results).toHaveLength(1);
        expect(results[0]).toMatchObject({
          type: PrincipalType.USER,
          name: 'Alice Smith',
          email: 'alice@test.com',
          username: 'alice',
          provider: 'local',
          source: 'local',
          isAdmin: true,
        });
        expect(harness.ids.isValid(results[0].id)).toBe(true);
        expect(results[0].idOnTheSource).toBe(results[0].id);
        expect(await stores().searchPrincipals('smi', 10, [PrincipalType.USER])).toHaveLength(1);
        expect(await stores().searchPrincipals('bob@', 10, [PrincipalType.USER])).toHaveLength(1);
      });

      it('finds groups and maps them to search results', async () => {
        await seedSearch();
        const [beta] = await stores().searchPrincipals('beta', 10, [PrincipalType.GROUP]);
        expect(beta).toMatchObject({
          type: PrincipalType.GROUP,
          name: 'Beta Team',
          email: 'beta@team.com',
          description: 'The beta team',
          source: 'entra',
          memberCount: 2,
          idOnTheSource: 'ext-beta',
        });
        const [alpha] = await stores().searchPrincipals('alpha', 10, [PrincipalType.GROUP]);
        expect(alpha).toMatchObject({ source: 'local', memberCount: 0 });
        expect(alpha.idOnTheSource).toBe(alpha.id);
      });

      it('finds roles whose name contains the pattern, ignoring case', async () => {
        await seedSearch();
        const results = await stores().searchPrincipals('ADM', 10, [PrincipalType.ROLE]);
        expect(results).toEqual([
          {
            id: 'ADMIN',
            type: PrincipalType.ROLE,
            name: 'ADMIN',
            source: 'local',
            idOnTheSource: 'ADMIN',
            isAdmin: true,
          },
        ]);
        expect(
          (await stores().searchPrincipals('LEAD', 10, [PrincipalType.ROLE])).map(
            ({ name }) => name,
          ),
        ).toEqual(['team-lead']);
        expect(await stores().searchPrincipals('nothing', 10, [PrincipalType.ROLE])).toEqual([]);
      });

      it('searches every type without a filter, and none with an empty one', async () => {
        await seedSearch();
        const results = await stores().searchPrincipals('team');
        expect(results.map(({ type, name }) => `${type}:${name}`).sort()).toEqual(
          [
            `${PrincipalType.GROUP}:Alpha Team`,
            `${PrincipalType.GROUP}:Beta Team`,
            `${PrincipalType.ROLE}:team-lead`,
          ].sort(),
        );
        expect(await stores().searchPrincipals('team', 10, [])).toEqual([]);
        expect(
          (
            await stores().searchPrincipals('a', 10, [PrincipalType.GROUP, PrincipalType.ROLE])
          ).some(({ type }) => type === PrincipalType.USER),
        ).toBe(false);
      });

      it('limits each type', async () => {
        await seedSearch();
        for (let index = 0; index < 3; index++) {
          await stores().createGroup({ name: `Team ${index}`, source: 'local' });
        }
        const results = await stores().searchPrincipals('team', 2);
        expect(results.filter(({ type }) => type === PrincipalType.GROUP)).toHaveLength(2);
        expect(results.filter(({ type }) => type === PrincipalType.ROLE)).toHaveLength(1);
      });

      it('treats pattern metacharacters as literal text', async () => {
        await createUser({ name: 'Literal .* User', email: 'literal-star@test.com' });
        await createUser({ name: 'Regex [invalid User', email: 'regex-invalid@test.com' });
        await harness.seedRaw('roles', [{ _id: harness.ids.generate(), name: 'a.b' }]);
        expect(await stores().searchPrincipals('.*', 10, [PrincipalType.USER])).toEqual([]);
        expect(
          (await stores().searchPrincipals('literal', 10, [PrincipalType.USER])).map(
            ({ name }) => name,
          ),
        ).toEqual(['Literal .* User']);
        expect(
          (await stores().searchPrincipals('[invalid', 10, [PrincipalType.USER])).map(
            ({ name }) => name,
          ),
        ).toEqual(['Regex [invalid User']);
        expect(await stores().searchPrincipals('.', 10, [PrincipalType.ROLE])).toHaveLength(1);
      });
    });

    describe('listGroups and countGroups', () => {
      const seedListing = async () => {
        await seedGroup({ name: 'Charlie', source: 'local', email: 'c@x.com' });
        await seedGroup({
          name: 'alpha',
          source: 'entra',
          idOnTheSource: 'e1',
          description: 'Ops',
        });
        await seedGroup({ name: 'Bravo', source: 'local', description: 'ops team' });
      };

      it('lists by name, filtered by source and by search in name, email or description', async () => {
        await seedListing();
        expect((await stores().listGroups()).map(({ name }) => name)).toEqual([
          'Bravo',
          'Charlie',
          'alpha',
        ]);
        expect((await stores().listGroups({ source: 'local' })).map(({ name }) => name)).toEqual([
          'Bravo',
          'Charlie',
        ]);
        expect((await stores().listGroups({ search: 'ALP' })).map(({ name }) => name)).toEqual([
          'alpha',
        ]);
        expect((await stores().listGroups({ search: 'c@x' })).map(({ name }) => name)).toEqual([
          'Charlie',
        ]);
        expect((await stores().listGroups({ search: 'ops' })).map(({ name }) => name)).toEqual([
          'Bravo',
          'alpha',
        ]);
        expect(await stores().listGroups({ search: '.*' })).toEqual([]);
      });

      it('pages with limit and offset', async () => {
        await seedListing();
        expect(
          (await stores().listGroups({ limit: 1, offset: 1 })).map(({ name }) => name),
        ).toEqual(['Charlie']);
      });

      it('counts what the listing pages through', async () => {
        await seedListing();
        expect(await stores().countGroups()).toBe(3);
        expect(await stores().countGroups({ source: 'entra' })).toBe(1);
        expect(await stores().countGroups({ search: 'ops' })).toBe(2);
        expect(await stores().countGroups({ search: 'none' })).toBe(0);
      });
    });

    describe('deleteGroup', () => {
      it('deletes the group and resolves it as it was, or null', async () => {
        const groupId = await seedGroup({ name: 'Gone', memberIds: ['m'] });
        const deleted = await stores().deleteGroup(groupId);
        expect(idOf(harness, deleted?._id)).toBe(groupId);
        expect(deleted).toMatchObject({ name: 'Gone', memberIds: ['m'] });
        expect(await harness.readRaw('groups')).toEqual([]);
        expect(await stores().deleteGroup(groupId)).toBeNull();
      });
    });

    describe('removeMemberById and removeMemberByIdTracked', () => {
      it('removes the member key as is and reports the change once', async () => {
        const groupId = await seedGroup({ name: 'Team', memberIds: ['m1', 'm2'] });
        const first = await stores().removeMemberByIdTracked(groupId, 'm1');
        expect(first.changed).toBe(true);
        expect(first.group?.memberIds).toEqual(['m2']);
        const second = await stores().removeMemberByIdTracked(groupId, 'm1');
        expect(second).toMatchObject({ changed: false, group: { memberIds: ['m2'] } });
        expect(await stores().removeMemberByIdTracked(harness.ids.generate(), 'm1')).toEqual({
          group: null,
          changed: false,
        });
      });

      it('resolves the group as after the call, or null', async () => {
        const groupId = await seedGroup({ name: 'Team', memberIds: ['m1', 'm2'] });
        expect((await stores().removeMemberById(groupId, 'm2'))?.memberIds).toEqual(['m1']);
        expect((await stores().removeMemberById(groupId, 'absent'))?.memberIds).toEqual(['m1']);
        expect(await stores().removeMemberById(harness.ids.generate(), 'm1')).toBeNull();
      });

      it('stamps the update time on a change', async () => {
        const groupId = await seedGroup({
          name: 'Team',
          memberIds: ['m1'],
          updatedAt: new Date('2020-01-01T00:00:00Z'),
        });
        await stores().removeMemberById(groupId, 'm1');
        const stored = (await readRawWhere(harness, 'groups', { _id: groupId }))[0];
        expect(timeOf(stored.updatedAt)).toBeGreaterThan(timeOf('2020-01-01T00:00:00Z'));
      });
    });
  });
}
