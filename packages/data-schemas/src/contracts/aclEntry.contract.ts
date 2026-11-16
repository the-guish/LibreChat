/* eslint-disable jest/no-export -- This file is a shared contract-test suite, not a
   spec: it exports the suite factory that each backend's own spec imports. The rule
   guards against accidental exports from spec files. */
/**
 * The `AclEntryStore` contract (`~/ports/aclEntry`), ported from `methods/aclEntry.spec.ts`,
 * `methods/aclEntry.namedReads.spec.ts`, `methods/aclEntry.tenant.spec.ts` and
 * `methods/aclEntry.parity.spec.ts`: grants (a user's or group's id given as a string is stored
 * as the id it names), the permission bit masks (every required bit, supersets, the insights
 * bit), effective permissions, the guarded bit changes (concurrent changes all land, a legacy
 * entry without bits counts as none), accessible and public resources, deletes, expiry, the role
 * bit replacements and bulk writes in the store query language, principal deletes and moves in
 * the caller's tenant partition, the owner reads, the two named reads that join access roles,
 * users and groups, and transactions (a transaction's writes are rolled back with it and seen by
 * its own reads).
 *
 * Principal ids are matched as given (the port's known leak), so principal lists pass a user's
 * or group's id as the id value the store hands out (`harness.ids.toStoreId`), and entries of
 * users and groups are created through the store, never seeded raw. The suite needs a harness
 * whose store runs transactions (the MongoDB spec runs on a replica set).
 *
 * Cases that inject write failures or races through spies (a concurrent write between the read
 * and the guarded write, a move or undo that fails, attempts running out), check the read
 * preference, the pipeline text, the schema's bounds and indexes, or the pure
 * `permissionBitSupersets` helper stay in the method specs. Nothing here may import `mongoose` or
 * the MongoDB driver.
 */
import {
  ResourceType,
  PrincipalType,
  PermissionBits,
  PrincipalModel,
} from 'librechat-data-provider';
import type { ContractHarness, RawRecord } from './harness';
import type { IAclEntry } from '~/types';
import type { AclStorePrincipal } from '~/ports/aclEntry';
import type { IdLike, StoreTransaction } from '~/ports/common';
import { tenantStorage } from '~/config/tenantContext';
import { idOf, readRawWhere, timeOf, useContractHarness } from './support';
import { RoleBits } from '~/common';

const { VIEW, EDIT, DELETE, SHARE, VIEW_INSIGHTS: INSIGHTS } = PermissionBits;
const USER = PrincipalType.USER;
const GROUP = PrincipalType.GROUP;
const ROLE = PrincipalType.ROLE;
const PUBLIC = PrincipalType.PUBLIC;
const AGENT = ResourceType.AGENT;

export function describeAclEntryContract(harness: ContractHarness): void {
  describe(`AclEntryStore contract: ${harness.name}`, () => {
    useContractHarness(harness);

    const stores = () => harness.createStores().aclEntries;
    const inTenant = <T>(tenantId: string, run: () => Promise<T>): Promise<T> =>
      tenantStorage.run({ tenantId }, run);
    const newId = () => harness.ids.generate();
    /** A user's or group's id as the store hands it out. */
    const storeId = (hex: string) => harness.ids.toStoreId(hex);
    const userPrincipal = (hex: string) => ({ principalType: USER, principalId: storeId(hex) });
    const groupPrincipal = (hex: string) => ({ principalType: GROUP, principalId: storeId(hex) });
    const rolePrincipal = (name: string) => ({ principalType: ROLE, principalId: name });
    const publicPrincipal = { principalType: PUBLIC };
    /** Grants `bits` on an agent; user and group ids are given as strings. */
    const grant = (
      principalType: PrincipalType,
      principalId: string | null,
      resourceId: string,
      bits: number,
      resourceType: string = AGENT,
    ) => stores().grantPermission(principalType, principalId, resourceType, resourceId, bits);
    const ids = (values: IdLike[]) => values.map((value) => idOf(harness, value)).sort();
    const rawEntry = async (entry: IAclEntry | null | undefined) =>
      (await readRawWhere(harness, 'aclentries', { _id: idOf(harness, entry?._id) }))[0];
    const bitsOf = async (entry: IAclEntry | null | undefined) => (await rawEntry(entry))?.permBits;

    describe('grantPermission', () => {
      it('creates an entry for a user, given its id as a string, and resolves it', async () => {
        const userId = newId();
        const resourceId = newId();
        const grantedBy = newId();
        const before = Date.now();
        const entry = await stores().grantPermission(
          USER,
          userId,
          AGENT,
          resourceId,
          VIEW | EDIT,
          grantedBy,
        );
        expect(entry).toMatchObject({
          principalType: USER,
          principalModel: PrincipalModel.USER,
          resourceType: AGENT,
          permBits: VIEW | EDIT,
        });
        expect(idOf(harness, entry?.principalId)).toBe(userId);
        expect(idOf(harness, entry?.resourceId)).toBe(resourceId);
        const stored = await rawEntry(entry);
        expect(stored).toMatchObject({
          principalId: userId,
          resourceId,
          grantedBy,
          permBits: VIEW | EDIT,
        });
        expect(timeOf(stored.grantedAt)).toBeGreaterThanOrEqual(before - 1000);
        /** A string and the store's id name the same principal. */
        expect(await stores().hasPermission([userPrincipal(userId)], AGENT, resourceId, VIEW)).toBe(
          true,
        );
      });

      it('creates entries for a group, a role by name, and the public', async () => {
        const groupId = newId();
        const resourceId = newId();
        const group = await grant(GROUP, groupId, resourceId, VIEW);
        const role = await grant(ROLE, 'editor', resourceId, EDIT);
        const everyone = await grant(PUBLIC, null, resourceId, VIEW);
        expect(group?.principalModel).toBe(PrincipalModel.GROUP);
        expect((await rawEntry(group)).principalId).toBe(groupId);
        expect(role).toMatchObject({ principalId: 'editor', principalModel: PrincipalModel.ROLE });
        expect(everyone?.principalType).toBe(PUBLIC);
        expect((await rawEntry(everyone)).principalId ?? null).toBeNull();
        expect(await harness.readRaw('aclentries')).toHaveLength(3);
      });

      it("replaces the principal's bits on a second grant, keeping one entry", async () => {
        const userId = newId();
        const resourceId = newId();
        const first = await grant(USER, userId, resourceId, VIEW);
        const second = await stores().grantPermission(
          USER,
          storeId(userId),
          AGENT,
          resourceId,
          VIEW | EDIT | DELETE,
        );
        expect(idOf(harness, second?._id)).toBe(idOf(harness, first?._id));
        expect(second?.permBits).toBe(VIEW | EDIT | DELETE);
        expect(await harness.readRaw('aclentries')).toHaveLength(1);
      });

      it('stamps roleId and expiredAt when given, keeping other fields', async () => {
        const userId = newId();
        const resourceId = newId();
        const roleId = newId();
        const grantedBy = newId();
        const expiredAt = new Date(Date.now() + 86_400_000);
        await stores().grantPermission(USER, userId, AGENT, resourceId, VIEW, grantedBy);
        const entry = await stores().grantPermission(
          USER,
          userId,
          AGENT,
          resourceId,
          EDIT,
          undefined,
          undefined,
          roleId,
          expiredAt,
        );
        const stored = await rawEntry(entry);
        expect(stored).toMatchObject({ roleId, grantedBy, permBits: EDIT });
        expect(timeOf(stored.expiredAt)).toBe(expiredAt.getTime());
      });

      it('keeps one public entry per resource whatever principal id is given', async () => {
        const resourceId = newId();
        await grant(PUBLIC, null, resourceId, VIEW);
        await stores().grantPermission(PUBLIC, 'ignored', AGENT, resourceId, VIEW | EDIT);
        const stored = await harness.readRaw('aclentries');
        expect(stored).toHaveLength(1);
        expect(stored[0].permBits).toBe(VIEW | EDIT);
      });

      it('stamps the active tenant on an entry created inside a tenant', async () => {
        const entry = await inTenant('tenant-a', () => grant(ROLE, 'editor', newId(), VIEW));
        expect((await rawEntry(entry)).tenantId).toBe('tenant-a');
      });
    });

    describe('findEntriesByResource', () => {
      it('reads every entry on the resource, of every principal', async () => {
        const resourceId = newId();
        await grant(USER, newId(), resourceId, VIEW);
        await grant(GROUP, newId(), resourceId, EDIT);
        await grant(PUBLIC, null, resourceId, VIEW);
        await grant(USER, newId(), newId(), VIEW);
        await grant(USER, newId(), resourceId, VIEW, ResourceType.PROMPTGROUP);
        const entries = await stores().findEntriesByResource(AGENT, resourceId);
        expect(entries.map(({ principalType }) => principalType).sort()).toEqual(
          [GROUP, PUBLIC, USER].sort(),
        );
        expect(await stores().findEntriesByResource(AGENT, storeId(resourceId))).toHaveLength(3);
        expect(await stores().findEntriesByResource(AGENT, newId())).toEqual([]);
      });
    });

    describe('findEntriesByPrincipalsAndResource', () => {
      it("reads the principals' entries on the resource, the public by type alone", async () => {
        const userId = newId();
        const groupId = newId();
        const resourceId = newId();
        await grant(USER, userId, resourceId, VIEW);
        await grant(GROUP, groupId, resourceId, EDIT);
        await grant(PUBLIC, null, resourceId, VIEW);
        await grant(USER, newId(), resourceId, DELETE);
        const entries = await stores().findEntriesByPrincipalsAndResource(
          [userPrincipal(userId), groupPrincipal(groupId), publicPrincipal],
          AGENT,
          resourceId,
        );
        expect(entries.map(({ permBits }) => permBits).sort()).toEqual([VIEW, VIEW, EDIT].sort());
        const readPrimary = await stores().findEntriesByPrincipalsAndResource(
          [userPrincipal(userId)],
          AGENT,
          resourceId,
          undefined,
          true,
        );
        expect(readPrimary).toHaveLength(1);
        expect(
          await stores().findEntriesByPrincipalsAndResource(
            [rolePrincipal('x')],
            AGENT,
            resourceId,
          ),
        ).toEqual([]);
      });
    });

    describe('hasPermission', () => {
      it('requires every bit of the mask, from any principal', async () => {
        const userId = newId();
        const groupId = newId();
        const resourceId = newId();
        await grant(USER, userId, resourceId, VIEW | INSIGHTS);
        await grant(GROUP, groupId, resourceId, VIEW | EDIT);
        const has = (principals: AclStorePrincipal[], bits: number) =>
          stores().hasPermission(principals, AGENT, resourceId, bits);
        expect(await has([userPrincipal(userId)], VIEW)).toBe(true);
        expect(await has([userPrincipal(userId)], VIEW | INSIGHTS)).toBe(true);
        expect(await has([userPrincipal(userId)], VIEW | EDIT)).toBe(false);
        expect(await has([groupPrincipal(groupId)], VIEW | EDIT)).toBe(true);
        expect(await has([userPrincipal(userId), groupPrincipal(groupId)], EDIT)).toBe(true);
        /** Bits held by different principals do not combine into one match. */
        expect(await has([userPrincipal(userId), groupPrincipal(groupId)], EDIT | INSIGHTS)).toBe(
          false,
        );
        expect(await has([userPrincipal(newId())], VIEW)).toBe(false);
      });

      it('matches the public by type, and a role by name', async () => {
        const resourceId = newId();
        await grant(PUBLIC, null, resourceId, VIEW);
        await grant(ROLE, 'editor', resourceId, VIEW | EDIT);
        expect(await stores().hasPermission([publicPrincipal], AGENT, resourceId, VIEW)).toBe(true);
        expect(
          await stores().hasPermission([rolePrincipal('editor')], AGENT, resourceId, EDIT),
        ).toBe(true);
        expect(
          await stores().hasPermission([rolePrincipal('Editor')], AGENT, resourceId, EDIT),
        ).toBe(false);
      });

      it.each([
        [VIEW | EDIT | DELETE | SHARE | INSIGHTS, VIEW | SHARE, true],
        [VIEW | DELETE, VIEW | DELETE, true],
        [VIEW, 0, true],
        [0, 0, true],
        [EDIT, VIEW, false],
        [VIEW | EDIT, VIEW | EDIT | DELETE, false],
      ])('an entry with %i satisfies %i: %j', async (stored, required, expected) => {
        const resourceId = newId();
        await grant(ROLE, 'r', resourceId, stored);
        expect(
          await stores().hasPermission([rolePrincipal('r')], AGENT, resourceId, required),
        ).toBe(expected);
      });

      it('matches nothing for a mask outside the known bits', async () => {
        const resourceId = newId();
        await grant(ROLE, 'r', resourceId, VIEW | EDIT | DELETE | SHARE | INSIGHTS);
        for (const required of [-1, 32, 1.5, 2 ** 40 + 1]) {
          expect(
            await stores().hasPermission([rolePrincipal('r')], AGENT, resourceId, required),
          ).toBe(false);
        }
      });
    });

    describe('getEffectivePermissions', () => {
      it("unions the principals' bits on the resource, 0 without entries", async () => {
        const userId = newId();
        const resourceId = newId();
        await grant(USER, userId, resourceId, VIEW);
        await grant(ROLE, 'editor', resourceId, EDIT);
        await grant(PUBLIC, null, resourceId, SHARE);
        await grant(ROLE, 'other', resourceId, DELETE);
        expect(
          await stores().getEffectivePermissions(
            [userPrincipal(userId), rolePrincipal('editor'), publicPrincipal],
            AGENT,
            resourceId,
          ),
        ).toBe(VIEW | EDIT | SHARE);
        expect(
          await stores().getEffectivePermissions([userPrincipal(userId)], AGENT, newId()),
        ).toBe(0);
      });
    });

    describe('getEffectivePermissionsForResources', () => {
      it('unions bits per resource, keyed by stringified id, leaving out resources without bits', async () => {
        const userId = newId();
        const groupId = newId();
        const [first, second, third] = [newId(), newId(), newId()];
        await grant(USER, userId, first, VIEW);
        await grant(GROUP, groupId, first, EDIT);
        await grant(PUBLIC, null, second, VIEW);
        await grant(USER, newId(), third, DELETE);
        const map = await stores().getEffectivePermissionsForResources(
          [userPrincipal(userId), groupPrincipal(groupId), publicPrincipal],
          AGENT,
          [first, storeId(second), third, newId()],
        );
        expect([...map.entries()].sort()).toEqual(
          [
            [first, VIEW | EDIT],
            [second, VIEW],
          ].sort(),
        );
      });

      it('is empty for no resources', async () => {
        const userId = newId();
        await grant(USER, userId, newId(), VIEW);
        expect(
          (await stores().getEffectivePermissionsForResources([userPrincipal(userId)], AGENT, []))
            .size,
        ).toBe(0);
      });

      it('handles a large batch', async () => {
        const resourceIds = Array.from({ length: 60 }, newId);
        for (const [index, resourceId] of resourceIds.entries()) {
          await grant(ROLE, 'r', resourceId, index % 2 === 0 ? VIEW : VIEW | EDIT);
        }
        const map = await stores().getEffectivePermissionsForResources(
          [rolePrincipal('r')],
          AGENT,
          resourceIds,
        );
        expect(map.size).toBe(60);
        expect(map.get(resourceIds[1])).toBe(VIEW | EDIT);
      });
    });

    describe('modifyPermissionBits', () => {
      const setup = async (bits: number) => {
        const userId = newId();
        const resourceId = newId();
        const entry = await grant(USER, userId, resourceId, bits);
        const modify = (add?: number | null, remove?: number | null, maxAttempts?: number) =>
          stores().modifyPermissionBits(
            USER,
            userId,
            AGENT,
            resourceId,
            add,
            remove,
            undefined,
            maxAttempts,
          );
        return { entry, userId, resourceId, modify };
      };

      it('adds bits, leaving the others', async () => {
        const { entry, modify } = await setup(VIEW | INSIGHTS);
        expect((await modify(EDIT, null))?.permBits).toBe(VIEW | EDIT | INSIGHTS);
        expect(await bitsOf(entry)).toBe(VIEW | EDIT | INSIGHTS);
      });

      it('removes bits, leaving the others', async () => {
        const { entry, modify } = await setup(VIEW | EDIT | INSIGHTS);
        expect((await modify(null, EDIT))?.permBits).toBe(VIEW | INSIGHTS);
        expect(await bitsOf(entry)).toBe(VIEW | INSIGHTS);
      });

      it('adds then removes, so a bit in both masks is removed', async () => {
        const { modify } = await setup(VIEW | INSIGHTS);
        expect((await modify(EDIT | SHARE, EDIT))?.permBits).toBe(VIEW | SHARE | INSIGHTS);
      });

      it('resolves the entry unchanged when neither mask is given', async () => {
        const { entry, modify } = await setup(VIEW | INSIGHTS);
        const unchanged = await modify(null, null);
        expect(idOf(harness, unchanged?._id)).toBe(idOf(harness, entry?._id));
        expect(unchanged?.permBits).toBe(VIEW | INSIGHTS);
      });

      it('resolves null and creates nothing when the principal has no entry', async () => {
        expect(
          await stores().modifyPermissionBits(USER, newId(), AGENT, newId(), EDIT, VIEW),
        ).toBeNull();
        expect(await harness.readRaw('aclentries')).toEqual([]);
      });

      it('keeps the grant metadata and accepts the principal as the store id', async () => {
        const { entry, userId, resourceId } = await setup(VIEW);
        const before = await rawEntry(entry);
        await stores().modifyPermissionBits(USER, storeId(userId), AGENT, resourceId, EDIT);
        const after = await rawEntry(entry);
        expect(after.permBits).toBe(VIEW | EDIT);
        expect(timeOf(after.grantedAt)).toBe(timeOf(before.grantedAt));
      });

      it('changes the public entry and a role entry', async () => {
        const resourceId = newId();
        const everyone = await grant(PUBLIC, null, resourceId, VIEW);
        const role = await grant(ROLE, 'editor', resourceId, VIEW);
        await stores().modifyPermissionBits(PUBLIC, null, AGENT, resourceId, EDIT);
        await stores().modifyPermissionBits(ROLE, 'editor', AGENT, resourceId, SHARE, VIEW);
        expect(await bitsOf(everyone)).toBe(VIEW | EDIT);
        expect(await bitsOf(role)).toBe(SHARE);
      });

      it('treats a legacy entry without bits as holding none', async () => {
        const resourceId = newId();
        const _id = newId();
        await harness.seedRaw('aclentries', [
          {
            _id,
            principalType: ROLE,
            principalId: 'legacy',
            principalModel: PrincipalModel.ROLE,
            resourceType: AGENT,
            resourceId,
          },
        ]);
        const updated = await stores().modifyPermissionBits(
          ROLE,
          'legacy',
          AGENT,
          resourceId,
          EDIT,
          VIEW,
        );
        expect(updated?.permBits).toBe(EDIT);
        expect((await readRawWhere(harness, 'aclentries', { _id }))[0].permBits).toBe(EDIT);
      });

      it('lands every one of concurrent changes to one entry', async () => {
        const { entry, modify } = await setup(VIEW);
        await Promise.all([
          modify(EDIT, null, 10),
          modify(DELETE, null, 10),
          modify(SHARE, null, 10),
          modify(INSIGHTS, VIEW, 10),
        ]);
        expect(await bitsOf(entry)).toBe(EDIT | DELETE | SHARE | INSIGHTS);
      });

      it('refuses a mask that is not a nonnegative 31-bit integer', async () => {
        const { entry, modify } = await setup(VIEW);
        await expect(modify(-1, null)).rejects.toThrow('Invalid permBits');
        await expect(modify(null, 2 ** 31)).rejects.toThrow('Invalid permBits');
        expect(await bitsOf(entry)).toBe(VIEW);
      });
    });

    describe('findAccessibleResources', () => {
      it('resolves each resource of the type on which any principal holds every bit, once', async () => {
        const userId = newId();
        const groupId = newId();
        const [owned, shared, publicOne, viewOnly, other] = [
          newId(),
          newId(),
          newId(),
          newId(),
          newId(),
        ];
        await grant(USER, userId, owned, VIEW | EDIT);
        await grant(GROUP, groupId, owned, VIEW | EDIT | DELETE);
        await grant(GROUP, groupId, shared, VIEW | EDIT);
        await grant(PUBLIC, null, publicOne, VIEW | EDIT);
        await grant(USER, userId, viewOnly, VIEW);
        await grant(USER, newId(), other, VIEW | EDIT);
        await grant(USER, userId, newId(), VIEW | EDIT, ResourceType.PROMPTGROUP);
        const principals = [userPrincipal(userId), groupPrincipal(groupId), publicPrincipal];
        expect(ids(await stores().findAccessibleResources(principals, AGENT, VIEW | EDIT))).toEqual(
          [owned, shared, publicOne].sort(),
        );
        expect(ids(await stores().findAccessibleResources(principals, AGENT, VIEW))).toEqual(
          [owned, shared, publicOne, viewOnly].sort(),
        );
        expect(
          ids(await stores().findAccessibleResources(principals, AGENT, VIEW, undefined, true)),
        ).toHaveLength(4);
      });

      it('considers only the given resources, and nothing for an empty bound', async () => {
        const userId = newId();
        const [first, second, third] = [newId(), newId(), newId()];
        for (const resourceId of [first, second, third]) {
          await grant(USER, userId, resourceId, VIEW);
        }
        const principals = [userPrincipal(userId)];
        expect(
          ids(
            await stores().findAccessibleResources(principals, AGENT, VIEW, [
              storeId(first),
              storeId(third),
              storeId(newId()),
            ]),
          ),
        ).toEqual([first, third].sort());
        expect(
          await stores().findAccessibleResources(principals, AGENT, VIEW, [storeId(newId())]),
        ).toEqual([]);
        expect(await stores().findAccessibleResources(principals, AGENT, VIEW, [])).toEqual([]);
      });

      it("resolves only the active tenant's resources inside a tenant", async () => {
        const [platformResource, tenantResource, otherResource] = [newId(), newId(), newId()];
        await grant(ROLE, 'r', platformResource, VIEW);
        await inTenant('tenant-a', () => grant(ROLE, 'r', tenantResource, VIEW));
        await inTenant('tenant-b', () => grant(ROLE, 'r', otherResource, VIEW));
        expect(
          ids(
            await inTenant('tenant-a', () =>
              stores().findAccessibleResources([rolePrincipal('r')], AGENT, VIEW),
            ),
          ),
        ).toEqual([tenantResource]);
      });
    });

    describe('findPublicResourceIds', () => {
      it('resolves the resources on which the public holds every bit, once', async () => {
        const [viewable, editable, privateOne] = [newId(), newId(), newId()];
        await grant(PUBLIC, null, viewable, VIEW);
        await grant(PUBLIC, null, editable, VIEW | EDIT);
        await grant(USER, newId(), privateOne, VIEW | EDIT);
        await grant(PUBLIC, null, newId(), VIEW, ResourceType.PROMPTGROUP);
        expect(ids(await stores().findPublicResourceIds(AGENT, VIEW))).toEqual(
          [viewable, editable].sort(),
        );
        expect(ids(await stores().findPublicResourceIds(AGENT, VIEW | EDIT))).toEqual([editable]);
        expect(
          ids(await stores().findPublicResourceIds(AGENT, VIEW, undefined, true)),
        ).toHaveLength(2);
        expect(await stores().findPublicResourceIds(ResourceType.MCPSERVER, VIEW)).toEqual([]);
      });

      it('considers only the given resources, and dedupes duplicate public entries', async () => {
        const [first, second] = [newId(), newId()];
        await grant(PUBLIC, null, first, VIEW);
        await grant(PUBLIC, null, second, VIEW);
        await harness.seedRaw('aclentries', [
          {
            _id: newId(),
            principalType: PUBLIC,
            resourceType: AGENT,
            resourceId: first,
            permBits: VIEW | EDIT,
          },
        ]);
        expect(ids(await stores().findPublicResourceIds(AGENT, VIEW))).toEqual(
          [first, second].sort(),
        );
        expect(ids(await stores().findPublicResourceIds(AGENT, VIEW, [storeId(second)]))).toEqual([
          second,
        ]);
        expect(await stores().findPublicResourceIds(AGENT, VIEW, [])).toEqual([]);
      });

      it("resolves only the active tenant's public resources inside a tenant", async () => {
        const [platformResource, tenantResource] = [newId(), newId()];
        await grant(PUBLIC, null, platformResource, VIEW);
        await inTenant('tenant-a', () => grant(PUBLIC, null, tenantResource, VIEW));
        expect(
          ids(await inTenant('tenant-a', () => stores().findPublicResourceIds(AGENT, VIEW))),
        ).toEqual([tenantResource]);
      });
    });

    describe('deleteAclEntries', () => {
      it('removes every entry the criteria match, counting them', async () => {
        const userId = newId();
        const resourceId = newId();
        await grant(USER, userId, resourceId, VIEW);
        await grant(PUBLIC, null, resourceId, VIEW);
        const kept = await grant(USER, userId, newId(), VIEW);
        const result = await stores().deleteAclEntries({ resourceType: AGENT, resourceId });
        expect(result.deletedCount).toBe(2);
        expect((await harness.readRaw('aclentries')).map(({ _id }) => _id)).toEqual([
          idOf(harness, kept?._id),
        ]);
        expect((await stores().deleteAclEntries({ resourceId })).deletedCount).toBe(0);
      });

      it("matches a user's entries by the store id, and criteria with operators", async () => {
        const userId = newId();
        await grant(USER, userId, newId(), VIEW);
        await grant(USER, userId, newId(), EDIT);
        await grant(ROLE, 'r', newId(), VIEW);
        expect(
          (
            await stores().deleteAclEntries({
              principalType: USER,
              principalId: storeId(userId),
              permBits: { $in: [EDIT] },
            })
          ).deletedCount,
        ).toBe(1);
        expect(
          (await stores().deleteAclEntries({ principalType: { $in: [USER, ROLE] } })).deletedCount,
        ).toBe(2);
      });
    });

    describe('setResourceEntriesExpiration', () => {
      it('sets, then removes, the expiry of every entry on the resource', async () => {
        const resourceId = newId();
        await grant(USER, newId(), resourceId, VIEW);
        await grant(PUBLIC, null, resourceId, VIEW);
        const other = await grant(USER, newId(), newId(), VIEW);
        const expiredAt = new Date(Date.now() + 86_400_000);
        const set = await stores().setResourceEntriesExpiration(AGENT, resourceId, expiredAt);
        expect(set).toMatchObject({ matchedCount: 2, modifiedCount: 2 });
        const onResource = await readRawWhere(harness, 'aclentries', { resourceId });
        expect(onResource.map((entry) => timeOf(entry.expiredAt))).toEqual([
          expiredAt.getTime(),
          expiredAt.getTime(),
        ]);
        expect((await rawEntry(other)).expiredAt ?? null).toBeNull();
        const cleared = await stores().setResourceEntriesExpiration(AGENT, resourceId, null);
        expect(cleared.matchedCount).toBe(2);
        for (const entry of await readRawWhere(harness, 'aclentries', { resourceId })) {
          expect(entry.expiredAt ?? null).toBeNull();
        }
      });

      it('matches nothing on another resource', async () => {
        expect(
          await stores().setResourceEntriesExpiration(AGENT, newId(), new Date(Date.now() + 1e7)),
        ).toMatchObject({ matchedCount: 0, modifiedCount: 0 });
      });
    });

    describe('replaceRoleBits', () => {
      const write = (
        principalId: string,
        resourceId: string,
        roleBits: number,
        roleId = newId(),
      ) => ({
        filter: { principalType: ROLE, principalId, resourceType: AGENT, resourceId },
        insert: {
          principalType: ROLE,
          principalId,
          principalModel: PrincipalModel.ROLE,
          resourceType: AGENT,
          resourceId,
        },
        roleBits,
        metadata: { roleId, grantedBy: newId() },
      });

      it('creates a missing entry with the role bits only, and reports it', async () => {
        const resourceId = newId();
        const requested = write('editor', resourceId, RoleBits.EDITOR | INSIGHTS);
        const result = await stores().replaceRoleBits([requested]);
        expect([...result.upsertedWrites]).toEqual([0]);
        const stored = await harness.readRaw('aclentries');
        expect(stored).toHaveLength(1);
        expect(stored[0]).toMatchObject({
          principalType: ROLE,
          principalId: 'editor',
          resourceId,
          permBits: RoleBits.EDITOR,
          roleId: requested.metadata.roleId,
          grantedBy: requested.metadata.grantedBy,
        });
      });

      it('replaces the role bits of existing entries, keeping the others', async () => {
        const resourceId = newId();
        const existing = await grant(ROLE, 'editor', resourceId, RoleBits.OWNER | INSIGHTS);
        const requested = write('editor', resourceId, RoleBits.VIEWER);
        const result = await stores().replaceRoleBits([requested]);
        expect(result.upsertedWrites.size).toBe(0);
        const stored = await rawEntry(existing);
        expect(stored.permBits).toBe(RoleBits.VIEWER | INSIGHTS);
        expect(stored.roleId).toBe(requested.metadata.roleId);
      });

      it('applies the writes in order and reports which created entries', async () => {
        const [first, second] = [newId(), newId()];
        await grant(ROLE, 'a', first, RoleBits.VIEWER);
        const result = await stores().replaceRoleBits([
          write('a', first, RoleBits.EDITOR),
          write('b', second, RoleBits.OWNER),
          write('b', second, RoleBits.VIEWER),
        ]);
        expect([...result.upsertedWrites]).toEqual([1]);
        expect((await readRawWhere(harness, 'aclentries', { principalId: 'b' }))[0].permBits).toBe(
          RoleBits.VIEWER,
        );
        expect((await readRawWhere(harness, 'aclentries', { principalId: 'a' }))[0].permBits).toBe(
          RoleBits.EDITOR,
        );
      });

      it('rewrites every entry the filter matches, each once', async () => {
        const resourceId = newId();
        await harness.seedRaw('aclentries', [
          {
            _id: newId(),
            principalType: ROLE,
            principalId: 'dup',
            principalModel: PrincipalModel.ROLE,
            resourceType: AGENT,
            resourceId,
            permBits: RoleBits.OWNER,
          },
          {
            _id: newId(),
            principalType: ROLE,
            principalId: 'dup',
            principalModel: PrincipalModel.ROLE,
            resourceType: AGENT,
            resourceId,
            permBits: VIEW | INSIGHTS,
          },
        ]);
        await stores().replaceRoleBits([write('dup', resourceId, RoleBits.EDITOR)]);
        expect(
          (await readRawWhere(harness, 'aclentries', { principalId: 'dup' }))
            .map(({ permBits }) => permBits)
            .sort(),
        ).toEqual([RoleBits.EDITOR, RoleBits.EDITOR | INSIGHTS].sort());
      });

      it('leaves earlier writes applied when a later one fails outside a transaction', async () => {
        const resourceId = newId();
        const failure = await stores()
          .replaceRoleBits([write('a', resourceId, RoleBits.EDITOR), write('b', resourceId, -1)])
          .then(
            () => undefined,
            (error: unknown) => error,
          );
        expect(failure).toMatchObject({ completedEntries: 1, transactional: false });
        expect((failure as Error).message).toMatch(/Invalid permBits/);
        expect(await readRawWhere(harness, 'aclentries', { principalId: 'a' })).toHaveLength(1);
      });
    });

    describe('bulkWriteAclEntries', () => {
      it('applies updates and upserts, counting what they matched, changed and inserted', async () => {
        const userId = newId();
        const resourceId = newId();
        await grant(USER, userId, resourceId, VIEW);
        await grant(ROLE, 'r', resourceId, VIEW);
        await grant(ROLE, 'r', newId(), VIEW);
        const newResource = newId();
        const result = await stores().bulkWriteAclEntries([
          {
            updateOne: {
              filter: { principalType: USER, principalId: storeId(userId), resourceId },
              update: { $set: { permBits: VIEW | EDIT } },
            },
          },
          {
            updateMany: {
              filter: { principalType: ROLE, principalId: 'r' },
              update: { $set: { permBits: VIEW | SHARE } },
            },
          },
          {
            updateOne: {
              filter: {
                principalType: ROLE,
                principalId: 'new',
                resourceType: AGENT,
                resourceId: newResource,
              },
              update: {
                $setOnInsert: { principalModel: PrincipalModel.ROLE, permBits: VIEW },
              },
              upsert: true,
            },
          },
        ]);
        expect(result).toMatchObject({ matchedCount: 3, modifiedCount: 3, upsertedCount: 1 });
        const created = (await readRawWhere(harness, 'aclentries', { principalId: 'new' }))[0];
        expect(created).toMatchObject({
          resourceType: AGENT,
          resourceId: newResource,
          permBits: VIEW,
        });
        expect(
          (await readRawWhere(harness, 'aclentries', { principalId: 'r' })).map(
            ({ permBits }) => permBits,
          ),
        ).toEqual([VIEW | SHARE, VIEW | SHARE]);
      });

      it('removes a field with $unset', async () => {
        const resourceId = newId();
        await grant(ROLE, 'r', resourceId, VIEW);
        await stores().setResourceEntriesExpiration(AGENT, resourceId, new Date(Date.now() + 1e7));
        await stores().bulkWriteAclEntries([
          { updateMany: { filter: { resourceId }, update: { $unset: { expiredAt: '' } } } },
        ]);
        expect((await harness.readRaw('aclentries'))[0].expiredAt ?? null).toBeNull();
      });

      it('ignores tenant ids in updates and adds the active tenant to filters and inserts', async () => {
        const resourceId = newId();
        const platform = await grant(ROLE, 'r', resourceId, VIEW);
        const tenantEntry = await inTenant('tenant-a', () => grant(ROLE, 'r', resourceId, VIEW));
        const result = await inTenant('tenant-a', () =>
          stores().bulkWriteAclEntries([
            {
              updateMany: {
                filter: { principalType: ROLE, principalId: 'r' },
                update: { $set: { permBits: EDIT, tenantId: 'tenant-b' } },
              },
            },
            {
              updateOne: {
                filter: {
                  principalType: ROLE,
                  principalId: 'inserted',
                  resourceType: AGENT,
                  resourceId,
                },
                update: { $setOnInsert: { principalModel: PrincipalModel.ROLE, permBits: VIEW } },
                upsert: true,
              },
            },
          ]),
        );
        expect(result).toMatchObject({ matchedCount: 1, upsertedCount: 1 });
        expect(await rawEntry(platform)).toMatchObject({ permBits: VIEW });
        expect(await rawEntry(tenantEntry)).toMatchObject({ permBits: EDIT, tenantId: 'tenant-a' });
        expect(
          (await readRawWhere(harness, 'aclentries', { principalId: 'inserted' }))[0].tenantId,
        ).toBe('tenant-a');
      });

      it('stops an ordered batch at a failing update, keeping the earlier ones', async () => {
        const [first, second] = [newId(), newId()];
        await grant(ROLE, 'a', first, VIEW);
        await grant(ROLE, 'b', second, VIEW);
        const failure = await stores()
          .bulkWriteAclEntries([
            { updateOne: { filter: { principalId: 'a' }, update: { $set: { permBits: EDIT } } } },
            {
              updateOne: {
                filter: { principalId: 'a' },
                update: { $set: { permBits: VIEW }, $unset: { permBits: '' } },
              },
            },
            { updateOne: { filter: { principalId: 'b' }, update: { $set: { permBits: EDIT } } } },
          ])
          .then(
            () => undefined,
            (error: unknown) => error,
          );
        expect(failure).toBeDefined();
        expect(
          (await harness.readRaw('aclentries')).map(({ principalId, permBits }) => [
            principalId,
            permBits,
          ]),
        ).toEqual([
          ['a', EDIT],
          ['b', VIEW],
        ]);
      });

      it('runs the remaining updates of an unordered batch past a failing one', async () => {
        const [first, second] = [newId(), newId()];
        await grant(ROLE, 'a', first, VIEW);
        await grant(ROLE, 'b', second, VIEW);
        const failure = await stores()
          .bulkWriteAclEntries(
            [
              {
                updateOne: {
                  filter: { principalId: 'a' },
                  update: { $set: { permBits: EDIT } },
                },
              },
              {
                updateOne: {
                  filter: {
                    principalType: ROLE,
                    principalId: 'bad',
                    resourceType: AGENT,
                    resourceId: newId(),
                  },
                  update: { $set: { permBits: VIEW }, $unset: { permBits: '' } },
                },
              },
              {
                updateOne: {
                  filter: { principalId: 'b' },
                  update: { $set: { permBits: EDIT } },
                },
              },
            ],
            { ordered: false },
          )
          .then(
            () => undefined,
            (error: unknown) => error,
          );
        expect(failure).toBeDefined();
        expect(
          (await harness.readRaw('aclentries'))
            .filter(({ principalId }) => principalId === 'a' || principalId === 'b')
            .map(({ permBits }) => permBits),
        ).toEqual([EDIT, EDIT]);
      });
    });

    describe('deletePrincipalAclEntries', () => {
      it('removes every entry a user or group holds, by its store id', async () => {
        const userId = newId();
        const groupId = newId();
        await grant(USER, userId, newId(), VIEW);
        await inTenant('tenant-a', () => grant(USER, userId, newId(), VIEW));
        await grant(GROUP, groupId, newId(), VIEW);
        await stores().deletePrincipalAclEntries({
          principalType: USER,
          principalId: storeId(userId),
        });
        const remaining = await harness.readRaw('aclentries');
        expect(remaining.map(({ principalId }) => principalId)).toEqual([groupId]);
      });

      it("removes a role's entries in the caller's partition only", async () => {
        const platform = await grant(ROLE, 'editor', newId(), VIEW);
        const tenant = await inTenant('tenant-a', () => grant(ROLE, 'editor', newId(), VIEW));
        await stores().deletePrincipalAclEntries({ principalType: ROLE, principalId: 'editor' });
        expect(await rawEntry(platform)).toBeUndefined();
        expect(await rawEntry(tenant)).toBeDefined();
        const tenantB = await inTenant('tenant-b', () => grant(ROLE, 'editor', newId(), VIEW));
        await inTenant('tenant-a', () =>
          stores().deletePrincipalAclEntries({ principalType: ROLE, principalId: 'editor' }),
        );
        expect(await rawEntry(tenant)).toBeUndefined();
        expect(await rawEntry(tenantB)).toBeDefined();
      });
    });

    describe('moveAclEntriesToPrincipal', () => {
      const entriesOf = (principalId: string) =>
        readRawWhere(harness, 'aclentries', { principalType: ROLE, principalId });

      it('re-keys a role principal entries, keeping identity and bits', async () => {
        const viewed = await grant(ROLE, 'editor', newId(), VIEW);
        await grant(ROLE, 'editor', newId(), EDIT);
        await grant(ROLE, 'other', newId(), VIEW);
        const moved = await stores().moveAclEntriesToPrincipal(ROLE, 'editor', 'writer');
        expect(moved).toHaveLength(2);
        expect(await entriesOf('editor')).toEqual([]);
        const writer = await entriesOf('writer');
        expect(writer.map(({ _id }) => _id).sort()).toEqual([...moved].sort());
        expect(writer.find(({ _id }) => _id === idOf(harness, viewed?._id))?.permBits).toBe(VIEW);
        expect(await entriesOf('other')).toHaveLength(1);
      });

      it('moves back only the entries a move returned', async () => {
        await grant(ROLE, 'editor', newId(), VIEW);
        const writerBefore = await grant(ROLE, 'writer', newId(), EDIT);
        const moved = await stores().moveAclEntriesToPrincipal(ROLE, 'editor', 'writer');
        expect(
          await stores().moveAclEntriesToPrincipal(ROLE, 'writer', 'editor', { ids: moved }),
        ).toEqual(moved);
        expect((await entriesOf('editor')).map(({ _id }) => _id)).toEqual(moved);
        expect((await entriesOf('writer')).map(({ _id }) => _id)).toEqual([
          idOf(harness, writerBefore?._id),
        ]);
      });

      it('resolves nothing for a principal without entries', async () => {
        expect(await stores().moveAclEntriesToPrincipal(ROLE, 'nobody', 'writer')).toEqual([]);
      });

      it("moves the caller's partition only, unclaimed entries as platform-level", async () => {
        const absent = await grant(ROLE, 'editor', newId(), VIEW);
        const unclaimedId = newId();
        await harness.seedRaw('aclentries', [
          {
            _id: unclaimedId,
            principalType: ROLE,
            principalId: 'editor',
            principalModel: PrincipalModel.ROLE,
            resourceType: AGENT,
            resourceId: newId(),
            permBits: EDIT,
            tenantId: null,
          },
        ]);
        const tenant = await inTenant('tenant-a', () => grant(ROLE, 'editor', newId(), DELETE));
        const platformMoved = await stores().moveAclEntriesToPrincipal(ROLE, 'editor', 'writer');
        expect([...platformMoved].sort()).toEqual([idOf(harness, absent?._id), unclaimedId].sort());
        const tenantMoved = await inTenant('tenant-a', () =>
          stores().moveAclEntriesToPrincipal(ROLE, 'editor', 'author'),
        );
        expect(tenantMoved).toEqual([idOf(harness, tenant?._id)]);
        expect(await entriesOf('editor')).toEqual([]);
      });
    });

    describe('getFirstOwnerIdsByResource', () => {
      it('resolves the earliest user owner per resource, by grant time first', async () => {
        const [first, second, viewerOnly] = [newId(), newId(), newId()];
        const [early, late, insightsOwner] = [newId(), newId(), newId()];
        await grant(USER, late, first, RoleBits.OWNER);
        const earlyEntry = await grant(USER, early, first, RoleBits.OWNER);
        await stores().bulkWriteAclEntries([
          {
            updateOne: {
              filter: { _id: idOf(harness, earlyEntry?._id) },
              update: { $set: { grantedAt: new Date('2020-01-01T00:00:00Z') } },
            },
          },
        ]);
        await grant(USER, insightsOwner, second, RoleBits.OWNER | INSIGHTS);
        await grant(USER, newId(), viewerOnly, VIEW);
        await grant(USER, newId(), second, RoleBits.OWNER, ResourceType.PROMPTGROUP);
        await grant(GROUP, newId(), viewerOnly, RoleBits.OWNER);
        const owners = await stores().getFirstOwnerIdsByResource(AGENT, [
          first,
          storeId(second),
          viewerOnly,
          'not-an-id',
        ]);
        expect([...owners.entries()].sort()).toEqual(
          [
            [first, early],
            [second, insightsOwner],
          ].sort(),
        );
      });

      it('is empty for no resources, or ids the store never generated', async () => {
        await grant(USER, newId(), newId(), RoleBits.OWNER);
        expect((await stores().getFirstOwnerIdsByResource(AGENT, [])).size).toBe(0);
        expect((await stores().getFirstOwnerIdsByResource(AGENT, ['nope'])).size).toBe(0);
      });
    });

    describe('getSoleOwnedResourceIds', () => {
      it('resolves the resources on which only the user holds DELETE', async () => {
        const userId = newId();
        const [sole, coOwnedByUser, coOwnedByGroup, viewerAlongside, noDelete, prompt] = [
          newId(),
          newId(),
          newId(),
          newId(),
          newId(),
          newId(),
        ];
        await grant(USER, userId, sole, RoleBits.OWNER);
        await grant(USER, userId, coOwnedByUser, RoleBits.OWNER);
        await grant(USER, newId(), coOwnedByUser, VIEW | DELETE);
        await grant(USER, userId, coOwnedByGroup, RoleBits.OWNER);
        await grant(GROUP, newId(), coOwnedByGroup, DELETE);
        await grant(USER, userId, viewerAlongside, RoleBits.OWNER);
        await grant(PUBLIC, null, viewerAlongside, VIEW | EDIT);
        await grant(USER, userId, noDelete, VIEW | EDIT);
        await grant(USER, userId, prompt, RoleBits.OWNER, ResourceType.PROMPTGROUP);
        expect(ids(await stores().getSoleOwnedResourceIds(storeId(userId), AGENT))).toEqual(
          [sole, viewerAlongside].sort(),
        );
        expect(
          ids(
            await stores().getSoleOwnedResourceIds(storeId(userId), [
              AGENT,
              ResourceType.PROMPTGROUP,
            ]),
          ),
        ).toEqual([sole, viewerAlongside, prompt].sort());
        expect(await stores().getSoleOwnedResourceIds(storeId(newId()), AGENT)).toEqual([]);
      });

      it('counts a role holding DELETE as another owner', async () => {
        const userId = newId();
        const resourceId = newId();
        await grant(USER, userId, resourceId, RoleBits.OWNER);
        await grant(ROLE, 'admins', resourceId, DELETE);
        expect(await stores().getSoleOwnedResourceIds(storeId(userId), AGENT)).toEqual([]);
      });
    });

    describe('the named reads', () => {
      const seedPrincipalRecords = async () => {
        const viewerRole = newId();
        const ownerRole = newId();
        const userId = newId();
        const groupId = newId();
        await harness.seedRaw('accessroles', [
          {
            _id: viewerRole,
            accessRoleId: 'agent_viewer',
            name: 'Viewer',
            resourceType: AGENT,
            permBits: 1,
          },
          {
            _id: ownerRole,
            accessRoleId: 'agent_owner',
            name: 'Owner',
            resourceType: AGENT,
            permBits: 15,
          },
        ]);
        await harness.seedRaw('users', [
          {
            _id: userId,
            name: 'Ada',
            username: 'ada',
            email: 'ada@example.com',
            avatar: 'ada.png',
            provider: 'local',
            role: 'ADMIN',
            password: 'hash',
            totpSecret: 'secret',
            tenantId: 'tenant-x',
          },
        ]);
        await harness.seedRaw('groups', [
          {
            _id: groupId,
            name: 'Engineers',
            email: 'eng@example.com',
            description: 'All engineers',
            source: 'entra',
            idOnTheSource: 'entra-eng',
            memberIds: ['a', 'b'],
          },
        ]);
        return { viewerRole, ownerRole, userId, groupId };
      };
      const grantWithRole = (
        principalType: PrincipalType,
        principalId: string | null,
        resourceId: string,
        bits: number,
        roleId?: string,
        resourceType: string = AGENT,
      ) =>
        stores().grantPermission(
          principalType,
          principalId,
          resourceType,
          resourceId,
          bits,
          undefined,
          undefined,
          roleId,
        );
      const byEntry = <T extends { _id: unknown }>(rows: T[]) =>
        new Map(rows.map((row) => [idOf(harness, row._id), row as T & RawRecord]));

      describe('listResourcePermissionPrincipals', () => {
        it('lists every entry on the resource with its access role, user and group joined', async () => {
          const records = await seedPrincipalRecords();
          const resourceId = newId();
          const missingUser = newId();
          const missingGroup = newId();
          const user = await grantWithRole(USER, records.userId, resourceId, 15, records.ownerRole);
          const group = await grantWithRole(
            GROUP,
            records.groupId,
            resourceId,
            1,
            records.viewerRole,
          );
          const role = await grantWithRole(ROLE, 'USER', resourceId, 1, records.viewerRole);
          const everyone = await grantWithRole(PUBLIC, null, resourceId, 1, records.viewerRole);
          const lostUser = await grantWithRole(USER, missingUser, resourceId, 3, newId());
          const lostGroup = await grantWithRole(GROUP, missingGroup, resourceId, 1);
          await grantWithRole(
            USER,
            records.userId,
            resourceId,
            15,
            records.ownerRole,
            ResourceType.REMOTE_AGENT,
          );
          await grantWithRole(USER, records.userId, newId(), 15, records.ownerRole);

          const rows = byEntry(await stores().listResourcePermissionPrincipals(AGENT, resourceId));
          expect(rows.size).toBe(6);
          const userRow = rows.get(idOf(harness, user?._id));
          expect(Object.keys(userRow ?? {}).sort()).toEqual(
            ['_id', 'accessRoleId', 'permBits', 'principalId', 'principalType', 'userInfo'].sort(),
          );
          expect(userRow).toMatchObject({
            principalType: USER,
            permBits: 15,
            accessRoleId: 'agent_owner',
          });
          expect(idOf(harness, userRow?.principalId)).toBe(records.userId);
          /** The joined user is whole, hidden fields and another tenant's included. */
          expect(userRow?.userInfo).toMatchObject({
            name: 'Ada',
            password: 'hash',
            totpSecret: 'secret',
            tenantId: 'tenant-x',
          });
          expect(idOf(harness, userRow?.userInfo?._id)).toBe(records.userId);

          const groupRow = rows.get(idOf(harness, group?._id));
          expect(groupRow).toMatchObject({ accessRoleId: 'agent_viewer' });
          expect(groupRow?.groupInfo).toMatchObject({ name: 'Engineers', memberIds: ['a', 'b'] });
          expect(groupRow).not.toHaveProperty('userInfo');

          const roleRow = rows.get(idOf(harness, role?._id));
          expect(roleRow).toMatchObject({ principalId: 'USER', accessRoleId: 'agent_viewer' });
          expect(roleRow).not.toHaveProperty('userInfo');
          expect(roleRow).not.toHaveProperty('groupInfo');

          const publicRow = rows.get(idOf(harness, everyone?._id));
          expect(publicRow).not.toHaveProperty('principalId');
          expect(publicRow?.accessRoleId).toBe('agent_viewer');

          /** Missing joined records and roles leave the field absent, never null. */
          const lostUserRow = rows.get(idOf(harness, lostUser?._id));
          expect(lostUserRow).not.toHaveProperty('userInfo');
          expect(lostUserRow).not.toHaveProperty('accessRoleId');
          const lostGroupRow = rows.get(idOf(harness, lostGroup?._id));
          expect(lostGroupRow).not.toHaveProperty('groupInfo');
          expect(lostGroupRow).not.toHaveProperty('accessRoleId');
        });

        it('matches the resource given as an id or its string, and nothing for a non-id', async () => {
          const resourceId = newId();
          await grant(PUBLIC, null, resourceId, VIEW);
          expect(await stores().listResourcePermissionPrincipals(AGENT, resourceId)).toHaveLength(
            1,
          );
          expect(
            await stores().listResourcePermissionPrincipals(AGENT, storeId(resourceId)),
          ).toHaveLength(1);
          expect(await stores().listResourcePermissionPrincipals(AGENT, 'not-an-id')).toEqual([]);
          expect(await stores().listResourcePermissionPrincipals(AGENT, newId())).toEqual([]);
        });

        it('scopes the entries, not the joined records, to the active tenant', async () => {
          const resourceId = newId();
          const otherTenantUser = newId();
          await harness.seedRaw('users', [
            {
              _id: otherTenantUser,
              name: 'Bob',
              email: 'bob@x.com',
              provider: 'local',
              tenantId: 'tenant-b',
            },
          ]);
          await inTenant('tenant-a', () => grant(USER, otherTenantUser, resourceId, VIEW));
          await inTenant('tenant-b', () => grant(PUBLIC, null, resourceId, VIEW));
          const rows = await inTenant('tenant-a', () =>
            stores().listResourcePermissionPrincipals(AGENT, resourceId),
          );
          expect(rows).toHaveLength(1);
          expect(rows[0].userInfo).toMatchObject({ name: 'Bob', tenantId: 'tenant-b' });
        });
      });

      describe('listUserPermissionHolders', () => {
        it('lists the user entries holding every required bit, with the user joined', async () => {
          const records = await seedPrincipalRecords();
          const resourceId = newId();
          const missingUser = newId();
          const holder = await grant(USER, records.userId, resourceId, VIEW | SHARE | INSIGHTS);
          const lost = await grant(USER, missingUser, resourceId, RoleBits.OWNER);
          await grant(USER, newId(), resourceId, VIEW | EDIT);
          await grant(GROUP, records.groupId, resourceId, RoleBits.OWNER);
          await grant(ROLE, 'USER', resourceId, RoleBits.OWNER);
          await grant(PUBLIC, null, resourceId, RoleBits.OWNER);
          await grant(USER, records.userId, newId(), RoleBits.OWNER);

          const rows = byEntry(await stores().listUserPermissionHolders(AGENT, resourceId, SHARE));
          expect([...rows.keys()].sort()).toEqual(
            [idOf(harness, holder?._id), idOf(harness, lost?._id)].sort(),
          );
          const holderRow = rows.get(idOf(harness, holder?._id));
          expect(Object.keys(holderRow ?? {}).sort()).toEqual(['_id', 'principalId', 'userInfo']);
          expect(idOf(harness, holderRow?.principalId)).toBe(records.userId);
          expect(holderRow?.userInfo).toMatchObject({ name: 'Ada', password: 'hash' });
          expect(rows.get(idOf(harness, lost?._id))).not.toHaveProperty('userInfo');
          expect(
            await stores().listUserPermissionHolders(AGENT, storeId(resourceId), SHARE),
          ).toHaveLength(2);
        });

        it('applies every-bit matching to any mask, and matches nothing for unknown bits', async () => {
          const resourceId = newId();
          await grant(USER, newId(), resourceId, VIEW | EDIT);
          await grant(USER, newId(), resourceId, VIEW);
          expect(await stores().listUserPermissionHolders(AGENT, resourceId, VIEW)).toHaveLength(2);
          expect(
            await stores().listUserPermissionHolders(AGENT, resourceId, VIEW | EDIT),
          ).toHaveLength(1);
          expect(await stores().listUserPermissionHolders(AGENT, resourceId, 64)).toEqual([]);
          expect(await stores().listUserPermissionHolders(AGENT, resourceId, -1)).toEqual([]);
          expect(await stores().listUserPermissionHolders(AGENT, 'not-an-id', VIEW)).toEqual([]);
        });

        it('scopes the entries to the active tenant', async () => {
          const resourceId = newId();
          await grant(USER, newId(), resourceId, SHARE);
          const tenantHolder = await inTenant('tenant-a', () =>
            grant(USER, newId(), resourceId, SHARE),
          );
          const rows = await inTenant('tenant-a', () =>
            stores().listUserPermissionHolders(AGENT, resourceId, SHARE),
          );
          expect(rows.map((row) => idOf(harness, row._id))).toEqual([
            idOf(harness, tenantHolder?._id),
          ]);
        });
      });
    });

    describe('transactions', () => {
      const transaction = <T>(fn: (tx: StoreTransaction | undefined) => Promise<T>) =>
        harness.createStores().transactions.transaction(fn);

      it('commits the writes made with the transaction, which its own reads see', async () => {
        const resourceId = newId();
        const userId = newId();
        const seen = await transaction<IAclEntry[]>(async (tx) => {
          expect(tx).toBeDefined();
          await stores().grantPermission(USER, userId, AGENT, resourceId, VIEW, undefined, tx);
          await stores().modifyPermissionBits(USER, userId, AGENT, resourceId, EDIT, null, tx);
          const inside = await stores().findEntriesByResource(AGENT, resourceId, tx);
          const outside = await stores().findEntriesByResource(AGENT, resourceId);
          expect(outside).toEqual([]);
          return inside;
        });
        expect(seen.map(({ permBits }) => permBits)).toEqual([VIEW | EDIT]);
        expect(
          (
            await stores().findEntriesByPrincipalsAndResource(
              [userPrincipal(userId)],
              AGENT,
              resourceId,
            )
          ).map(({ permBits }) => permBits),
        ).toEqual([VIEW | EDIT]);
      });

      it('rolls back every write made with the transaction when it rejects', async () => {
        const resourceId = newId();
        const kept = await grant(ROLE, 'kept', resourceId, VIEW);
        const failure = new Error('abort');
        await expect(
          transaction(async (tx) => {
            await stores().grantPermission(ROLE, 'editor', AGENT, resourceId, EDIT, undefined, tx);
            await stores().deleteAclEntries({ principalId: 'kept' }, { session: tx });
            await stores().bulkWriteAclEntries(
              [{ updateMany: { filter: { resourceId }, update: { $set: { permBits: SHARE } } } }],
              { session: tx },
            );
            expect(
              await stores().findEntriesByPrincipalsAndResource(
                [rolePrincipal('editor')],
                AGENT,
                resourceId,
                tx,
              ),
            ).toHaveLength(1);
            throw failure;
          }),
        ).rejects.toBe(failure);
        const stored = await harness.readRaw('aclentries');
        expect(stored.map(({ _id }) => _id)).toEqual([idOf(harness, kept?._id)]);
        expect(stored[0].permBits).toBe(VIEW);
      });

      it('reports a failed role bit replacement in a transaction as transactional, and rolls it back', async () => {
        const resourceId = newId();
        const write = (principalId: string, roleBits: number) => ({
          filter: { principalType: ROLE, principalId, resourceType: AGENT, resourceId },
          insert: {
            principalType: ROLE,
            principalId,
            principalModel: PrincipalModel.ROLE,
            resourceType: AGENT,
            resourceId,
          },
          roleBits,
          metadata: {},
        });
        let failure: unknown;
        await transaction(async (tx) => {
          failure = await stores()
            .replaceRoleBits([write('a', RoleBits.EDITOR), write('b', -1)], { session: tx })
            .then(
              () => undefined,
              (error: unknown) => error,
            );
          throw failure;
        }).catch(() => undefined);
        expect(failure).toMatchObject({ completedEntries: 1, transactional: true });
        expect(await harness.readRaw('aclentries')).toEqual([]);
      });
    });
  });
}
