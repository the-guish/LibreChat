/**
 * The PostgreSQL `SystemGrantStore` (`~/ports/systemGrant`): the system capabilities granted to
 * roles, groups and users on the `systemgrants` table, through the collection primitive, with the
 * capability and scope rules of `~/methods/systemGrantRules`. Must not import `mongoose`,
 * `mongodb` or `bson`.
 *
 * `principalId` is a text column (the `objectIdOrString` override, §1.6): a user's or group's id
 * is stored as its canonical hex (a string form must be a valid 24-hex id, or the call throws, as
 * MongoDB's cast does; 12-character strings are refused, R7), a role's name as given. So an id
 * and its string form always name the same principal. Grants are insert-only upserts on the
 * unique `{ principalType, principalId, capability, tenantId }` index (`NULLS NOT DISTINCT`), so
 * concurrent grants of one capability create it once.
 */
import { PrincipalType, SystemRoles } from 'librechat-data-provider';
import type { ISystemGrant, SystemGrantMove } from '~/types';
import type { SystemGrantStore } from '~/ports/systemGrant';
import type { PostgresStoreContext } from './context';
import type { PgFilter } from '../collection';
import type { IdLike } from '~/ports/common';
import {
  grantScope,
  grantScopeKey,
  grantListFilter,
  grantsPageLimit,
  tenantCondition,
  capabilityCondition,
  resolveHeldCapabilities,
  heldCapabilityCandidates,
  grantPrincipalConditions,
  CONFIG_READ_ACCESS_PATTERN,
  SEED_SYSTEM_GRANTS_ATTEMPTS,
  seedSystemGrantsRetryDelay,
} from '~/methods/systemGrantRules';
import { StoreDuplicateKeyError } from '~/ports/storeErrors';
import { SystemCapabilities } from '~/admin/capabilities';
import { isValidObjectIdString } from '~/utils/objectId';
import { getSafeErrorFields } from '~/utils/errors';
import { toIdColumn } from '../values';
import logger from '~/config/winston';

/**
 * A principal id as stored: a role's name as given, a user's or group's id as its canonical hex
 * (a string must be a valid id, or this throws, as MongoDB's `normalizePrincipalId` does).
 */
export function normalizeGrantPrincipalId(
  principalId: IdLike,
  principalType: PrincipalType,
): string {
  if (typeof principalId === 'string') {
    if (principalType === PrincipalType.ROLE) {
      return principalId;
    }
    if (!isValidObjectIdString(principalId)) {
      throw new TypeError(`Invalid ObjectId string for ${principalType}: "${principalId}"`);
    }
    return principalId.toLowerCase();
  }
  return toIdColumn(principalId);
}

export function createPostgresSystemGrantStore(context: PostgresStoreContext): SystemGrantStore {
  const grants = () => context.collections().collection('systemgrants');
  const asGrant = (record: unknown) => record as ISystemGrant | null;
  const asGrants = (records: unknown) => records as ISystemGrant[];
  const normalize = normalizeGrantPrincipalId;

  /** The filter of one grant: the principal's capability in exactly one scope. */
  const grantFilter = (
    principalType: PrincipalType,
    principalId: string,
    capability: string,
    tenantId?: string | null,
  ): PgFilter => ({
    principalType,
    principalId,
    capability,
    tenantId: tenantId != null ? tenantId : { $exists: false },
  });

  /** The capability scopes (`grantScopeKey`) among `of` that `principalId` holds now. */
  async function findHeldScopes(
    principalType: PrincipalType,
    principalId: string,
    of: readonly Pick<ISystemGrant, 'capability' | 'tenantId'>[],
  ): Promise<Set<string>> {
    const held = (await grants().find(
      {
        principalType,
        principalId,
        capability: { $in: [...new Set(of.map((grant) => grant.capability))] },
      },
      { projection: 'capability tenantId' },
    )) as unknown as Array<Pick<ISystemGrant, 'capability' | 'tenantId'>>;
    return new Set(held.map(grantScopeKey));
  }

  async function restoreMovedGrants(
    principalType: PrincipalType,
    fromPrincipalId: IdLike,
    toPrincipalId: IdLike,
    move: SystemGrantMove,
  ): Promise<void> {
    const source = normalize(fromPrincipalId, principalType);
    const target = normalize(toPrincipalId, principalType);
    if (move.moved.length > 0) {
      await grants().updateMany(
        {
          _id: { $in: move.moved.map((grant) => String(grant._id)) },
          principalType,
          principalId: target,
        },
        { $set: { principalId: source } },
      );
    }
    if (move.superseded.length === 0) {
      return;
    }
    const heldKeys = await findHeldScopes(principalType, target, move.superseded);
    await Promise.all(
      move.superseded
        .filter((grant) => heldKeys.has(grantScopeKey(grant)))
        .map((grant) =>
          grants().updateOne(
            grantFilter(principalType, source, grant.capability, grant.tenantId),
            {
              $setOnInsert: {
                ...(grant as unknown as Record<string, unknown>),
                principalId: source,
              },
            },
            { upsert: true, timestamps: false },
          ),
        ),
    );
  }

  const store: SystemGrantStore = {
    /**
     * The ADMIN role's platform-level grant of every capability, as insert-only upserts in one
     * unordered bulk write (concurrent seeds converge on the unique index), retried with backoff.
     */
    async seedSystemGrants() {
      for (let attempt = 1; attempt <= SEED_SYSTEM_GRANTS_ATTEMPTS; attempt++) {
        try {
          const now = new Date();
          await grants().bulk(
            Object.values(SystemCapabilities).map((capability) => ({
              updateOne: {
                filter: grantFilter(PrincipalType.ROLE, SystemRoles.ADMIN, capability),
                update: {
                  $setOnInsert: {
                    principalType: PrincipalType.ROLE,
                    principalId: SystemRoles.ADMIN,
                    capability,
                    grantedAt: now,
                  },
                },
                upsert: true,
              },
            })),
            { ordered: false },
          );
          return;
        } catch (err) {
          if (attempt < SEED_SYSTEM_GRANTS_ATTEMPTS) {
            const delay = seedSystemGrantsRetryDelay(attempt);
            logger.warn(
              `[seedSystemGrants] Attempt ${attempt}/${SEED_SYSTEM_GRANTS_ATTEMPTS} failed, retrying in ${delay}ms: ${(err as Error).message ?? String(err)}`,
            );
            await new Promise((resolve) => setTimeout(resolve, delay));
          } else {
            logger.error(
              '[seedSystemGrants] Failed to seed capabilities after all retries. ' +
                'Admin panel access requires these grants.',
              err,
            );
          }
        }
      }
    },

    async grantCapability({ principalType, principalId, capability, tenantId, grantedBy }) {
      const normalizedPrincipalId = normalize(principalId, principalType);
      const filter = grantFilter(principalType, normalizedPrincipalId, capability, tenantId);
      /** Insert-only: re-asserting an existing grant mutates no field of it. */
      const update = {
        $setOnInsert: {
          principalType,
          principalId: normalizedPrincipalId,
          capability,
          grantedAt: new Date(),
          ...(grantedBy != null && { grantedBy }),
          ...(tenantId != null && { tenantId }),
        },
      };
      try {
        const result = await grants().updateOne(filter, update, { upsert: true });
        const created = result.upsertedCount === 1;
        const grant = await grants().findOne(
          created && result.upsertedId ? { _id: result.upsertedId } : filter,
        );
        return { grant: asGrant(grant), created };
      } catch (err) {
        if (err instanceof StoreDuplicateKeyError) {
          /** A concurrent insert won the race: the grant exists and this call did not create it. */
          return { grant: asGrant(await grants().findOne(filter)), created: false };
        }
        throw err;
      }
    },

    async revokeCapability({ principalType, principalId, capability, tenantId }) {
      const filter = grantFilter(
        principalType,
        normalize(principalId, principalType),
        capability,
        tenantId,
      );
      const result = await grants().deleteOne(filter);
      return { deletedCount: result.deletedCount ?? 0 };
    },

    async hasCapabilityForPrincipals({ principals, capability, tenantId }) {
      const principalsQuery = grantPrincipalConditions(principals, normalize);
      if (!principalsQuery.length) {
        return false;
      }
      const found = await grants().exists({
        $or: principalsQuery,
        capability: capabilityCondition(capability),
        ...tenantCondition(tenantId),
      });
      return found != null;
    },

    async hasAnyConfigReadAccess({ principals, tenantId }) {
      const principalsQuery = grantPrincipalConditions(principals, normalize);
      if (!principalsQuery.length) {
        return false;
      }
      const found = await grants().exists({
        $and: [
          { $or: principalsQuery },
          { capability: CONFIG_READ_ACCESS_PATTERN },
          tenantCondition(tenantId),
        ],
      });
      return found != null;
    },

    async getHeldCapabilities({ principals, capabilities, tenantId }) {
      const principalsQuery = grantPrincipalConditions(principals, normalize);
      if (!principalsQuery.length || !capabilities.length) {
        return new Set();
      }
      const docs = (await grants().find(
        {
          $or: principalsQuery,
          capability: { $in: heldCapabilityCandidates(capabilities) },
          ...tenantCondition(tenantId),
        },
        { projection: { capability: 1, _id: 0 } },
      )) as Array<{ capability: string }>;
      return resolveHeldCapabilities(capabilities, new Set(docs.map((d) => d.capability)));
    },

    async listGrants(options) {
      return asGrants(
        await grants().find(grantListFilter(options), {
          sort: { principalType: 1, capability: 1 },
          skip: options?.offset ?? 0,
          limit: grantsPageLimit(options?.limit),
        }),
      );
    },

    async countGrants(options) {
      return grants().count(grantListFilter(options));
    },

    async getCapabilitiesForPrincipal({ principalType, principalId, tenantId }) {
      return asGrants(
        await grants().find({
          principalType,
          principalId: normalize(principalId, principalType),
          ...tenantCondition(tenantId),
        }),
      );
    },

    async getCapabilitiesForPrincipals({ principals, tenantId }) {
      if (!principals.length) {
        return [];
      }
      const principalsQuery = principals
        .filter((p) => p.principalType !== PrincipalType.PUBLIC)
        .map((p) => ({
          principalType: p.principalType,
          principalId: normalize(p.principalId, p.principalType),
        }));
      if (!principalsQuery.length) {
        return [];
      }
      return asGrants(await grants().find({ $or: principalsQuery, ...tenantCondition(tenantId) }));
    },

    async findGrantsForPrincipal(principalType, principalId, options) {
      return asGrants(
        await grants().find({
          principalType,
          principalId: normalize(principalId, principalType),
          ...grantScope(options?.tenantId),
        }),
      );
    },

    /** Reads the scope's grants, then removes them, so a cascade can audit each removal. */
    async deleteGrantsForPrincipal(principalType, principalId, options) {
      const filter = {
        principalType,
        principalId: normalize(principalId, principalType),
        ...grantScope(options?.tenantId),
      };
      const removed = asGrants(await grants().find(filter));
      await grants().deleteMany(filter);
      return removed;
    },

    /**
     * Re-keys the principal's grants of one scope to another id (a role rename); a grant the
     * target already holds in the scope is removed from the source instead. A move that fails
     * part-way is undone (with `restoreMovedGrants`) before it rethrows.
     */
    async moveGrantsToPrincipal(principalType, fromPrincipalId, toPrincipalId, options) {
      const source = normalize(fromPrincipalId, principalType);
      const found = asGrants(
        await grants().find({
          principalType,
          principalId: source,
          ...grantScope(options?.tenantId),
        }),
      );
      if (found.length === 0) {
        return { moved: [], superseded: [] };
      }
      const target = normalize(toPrincipalId, principalType);
      const heldKeys = await findHeldScopes(principalType, target, found);
      const moved: ISystemGrant[] = [];
      const supersedable: ISystemGrant[] = [];
      for (const grant of found) {
        (heldKeys.has(grantScopeKey(grant)) ? supersedable : moved).push(grant);
      }
      const superseded: ISystemGrant[] = [];
      try {
        const removals = await Promise.allSettled(
          supersedable.map((grant) =>
            grants().findOneAndDelete({
              _id: String(grant._id),
              principalType,
              principalId: source,
            }),
          ),
        );
        const unconfirmed: string[] = [];
        let failure: unknown;
        removals.forEach((removal, index) => {
          if (removal.status === 'fulfilled') {
            if (removal.value) {
              superseded.push(removal.value as unknown as ISystemGrant);
            }
            return;
          }
          failure ??= removal.reason;
          unconfirmed.push(String(supersedable[index]._id));
        });
        if (unconfirmed.length > 0) {
          logger.error('[moveGrantsToPrincipal] removal of superseded grants not confirmed', {
            principalType,
            fromPrincipalId: fromPrincipalId.toString(),
            toPrincipalId: toPrincipalId.toString(),
            grantIds: unconfirmed.join(','),
          });
          throw failure;
        }
        if (moved.length > 0) {
          await grants().updateMany(
            {
              _id: { $in: moved.map((grant) => String(grant._id)) },
              principalType,
              principalId: source,
            },
            { $set: { principalId: target } },
          );
        }
      } catch (error) {
        const undo = { moved, superseded };
        await restoreMovedGrants(principalType, fromPrincipalId, toPrincipalId, undo).catch(
          (restoreError: unknown) =>
            logger.error('[moveGrantsToPrincipal] undo after a failed move failed', {
              principalType,
              fromPrincipalId: fromPrincipalId.toString(),
              toPrincipalId: toPrincipalId.toString(),
              grantIds: [...moved, ...superseded].map((grant) => String(grant._id)).join(','),
              ...getSafeErrorFields(restoreError),
            }),
        );
        throw error;
      }
      return { moved, superseded };
    },

    restoreMovedGrants,
  };
  return store;
}
