/**
 * The ACL entry rules every backend's `AclEntryStore` shares (docs/postgres-port/PHASE4.md §4,
 * "Domain rules"): the permission bit masks (supersets of a required mask, the owner mask), the
 * principal conditions of a permission read, and the guarded permission writes
 * (`modifyPermissionBits`' and `replaceRoleBits`' compare-and-set loop) on three storage steps.
 * Nothing here may import `mongoose`.
 */
import {
  PrincipalType,
  PermissionBits,
  permissionWriteAttemptsSchema,
} from 'librechat-data-provider';
import type { IAclEntry } from '~/types';
import { MAX_PERM_BITS } from '~/common/permissions';
import { RoleBits } from '~/common/enum';

/**
 * Empty frozen array shared by every rejection path. Returning a single
 * instance keeps the hot path allocation-free and freezes a known-safe value
 * so it can never mutate into a "match everything" list.
 */
const EMPTY_SUPERSETS: readonly number[] = Object.freeze([]);

const supersetCache = new Map<number, readonly number[]>();

/**
 * Enumerates every `permBits` value (in the range `[0, MAX_PERM_BITS]`) whose
 * set bits include all bits in `requiredBits`. Used with a `$in` filter to push
 * permission-mask matching down to the database without relying on the
 * `$bitsAllSet` query operator, which is not supported by Azure Cosmos DB for
 * MongoDB (see issue #12729).
 *
 * **Invariant:** stored `permBits` values must lie in `[0, MAX_PERM_BITS]`.
 * Values with higher-order bits set would never appear in the emitted `$in`
 * list and would silently produce false permission denials. The aclEntry
 * schema enforces this with a `max` validator; if the `PermissionBits` enum
 * grows, `MAX_PERM_BITS` auto-expands from the new enum values.
 *
 * **Cache safety:** callers sometimes forward user input directly (e.g.
 * `req.query.requiredPermission` is parsed and passed through without a range
 * check). To prevent the process-global cache from growing unboundedly from
 * attacker-supplied integers, any `requiredBits` outside `[0, MAX_PERM_BITS]`
 * or with bits set above the max returns a shared frozen empty array and is
 * NOT added to the cache. An empty `$in` list correctly matches zero rows,
 * which is the right behavior for a request asking for bits the system does
 * not recognize.
 *
 * For the current 5-bit `PermissionBits` enum the worst case is `required = 0`
 * which expands to 32 values; the best case (all bits required) expands to 1.
 * Results are memoized per `requiredBits` so the expansion runs at most once
 * per distinct mask over the process lifetime.
 */
export function permissionBitSupersets(requiredBits: number): readonly number[] {
  if (
    !Number.isInteger(requiredBits) ||
    requiredBits < 0 ||
    requiredBits > MAX_PERM_BITS ||
    (requiredBits & ~MAX_PERM_BITS) !== 0
  ) {
    return EMPTY_SUPERSETS;
  }
  const cached = supersetCache.get(requiredBits);
  if (cached !== undefined) {
    return cached;
  }
  const supersets: number[] = [];
  for (let v = 0; v <= MAX_PERM_BITS; v++) {
    if ((v & requiredBits) === requiredBits) {
      supersets.push(v);
    }
  }
  /**
   * Freeze the cached array so a future caller cannot mutate the shared cache
   * entry. All current callers only forward this to Mongoose's `$in`, which
   * does not mutate — freezing is cheap and prevents silent corruption.
   */
  const frozen = Object.freeze(supersets);
  supersetCache.set(requiredBits, frozen);
  return frozen;
}

/**
 * Attempts for a guarded permission write before it reports failure. Callers
 * may override per call; a conflict is only ever resolved by retrying, never by
 * writing over a value the caller did not observe.
 */
export const PERM_BITS_WRITE_ATTEMPTS: number = permissionWriteAttemptsSchema.parse(undefined);

/** One principal's role replacement, as requested by the caller. */
export type RoleBitsWrite = {
  /** Identity of the principal on the resource; never filters on permissions. */
  filter: Record<string, unknown>;
  /** Identity fields used only when the entry has to be created. */
  insert: Record<string, unknown>;
  /** The requested role's bits; non-role bits are masked off. */
  roleBits: number;
  /** Role metadata that must land in the SAME write as the role bits. */
  metadata: Record<string, unknown>;
};

/**
 * The permission mask a resource's owner holds: every bit, not merely VIEW. Shared so the
 * marketplace's author sort (`agent.ts`) and the owner-contact lookup below agree on which
 * ACL entry represents ownership, a disagreement would show two different authors for
 * one agent.
 */
export const OWNER_ACL_PERMISSION_BITS: number =
  PermissionBits.VIEW | PermissionBits.EDIT | PermissionBits.DELETE | PermissionBits.SHARE;

/**
 * Every `permBits` value that still means ownership. Granting Agent Insights ORs
 * `VIEW_INSIGHTS` into an owner's role bits (`packages/api/src/acl/accessControlService.ts`),
 * so an owner entry is not always exactly {@link OWNER_ACL_PERMISSION_BITS}; matching the
 * exact value would drop that owner and hand the agent's author back to whoever `author`
 * still names. Enumerated rather than `$bitsAllSet`, which DocumentDB rejects.
 */
export const OWNER_ACL_PERMISSION_BIT_SUPERSETS: readonly number[] =
  permissionBitSupersets(OWNER_ACL_PERMISSION_BITS);

/**
 * A stringified ObjectId is always exactly 24 hex characters. Checked explicitly rather
 * than with `ObjectId.isValid`, which also accepts any 12-character string and would turn
 * a stray identifier into a garbage query instead of dropping it.
 */
export const OBJECT_ID_HEX: RegExp = /^[0-9a-fA-F]{24}$/;

/**
 * The `$or` conditions of a permission read over `principalsList`: a public principal by type
 * alone, the others by type and id (as given).
 */
export function aclPrincipalConditions<Id>(
  principalsList: ReadonlyArray<{ principalType: string; principalId?: Id }>,
): Array<{ principalType: string; principalId?: Id }> {
  return principalsList.map((p) => ({
    principalType: p.principalType,
    ...(p.principalType !== PrincipalType.PUBLIC && { principalId: p.principalId }),
  }));
}

/** Reject values JavaScript bit operations would truncate. Missing legacy fields mean zero. */
export function permissionMask(value: unknown): number {
  if (value === undefined) return 0;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 0x7fffffff) {
    throw new Error('Invalid permBits: expected a nonnegative 31-bit integer');
  }
  return value;
}

/** An ACL entry as a guarded write reads it. */
export interface PermissionEntryRecord {
  _id: unknown;
  permBits?: number;
  [key: string]: unknown;
}

/** The storage steps of the guarded permission writes, in the backend's transaction type `Tx`. */
export interface PermissionWriteSteps<Entry extends PermissionEntryRecord, Tx> {
  /**
   * The entries matching `filter`, oldest `_id` first, as the write authority holds them (no
   * lagging replica outside a transaction).
   */
  readEntries(filter: Record<string, unknown>, tx?: Tx): Promise<Entry[]>;
  /** Sets `set` on the first entry `guard` matches; resolves how many it matched (0 or 1). */
  updateGuarded(
    guard: Record<string, unknown>,
    set: Record<string, unknown>,
    tx?: Tx,
  ): Promise<number>;
  /**
   * Inserts an entry from `filter`'s equalities and `setOnInsert` when none matches `filter`;
   * resolves how many it inserted (0 or 1).
   */
  insertIfMissing(
    filter: Record<string, unknown>,
    setOnInsert: Record<string, unknown>,
    tx?: Tx,
  ): Promise<number>;
  /** The entry as the store hands it out. */
  toEntry(record: Entry): IAclEntry;
  /** Whether `tx` is an open transaction (a failure may then roll the earlier writes back). */
  inTransaction(tx?: Tx): boolean;
}

/** The guarded permission writes over `steps`. */
export function createPermissionWrites<Entry extends PermissionEntryRecord, Tx>(
  steps: PermissionWriteSteps<Entry, Tx>,
): {
  /** `modifyPermissionBits` after its identity filter is built. */
  modifyEntryBits(
    identity: Record<string, unknown>,
    addBits: number | null | undefined,
    removeBits: number | null | undefined,
    tx?: Tx,
    maxAttempts?: number,
  ): Promise<IAclEntry | null>;
  replaceRoleBits(
    writes: RoleBitsWrite[],
    options?: { tx?: Tx; maxAttempts?: number },
  ): Promise<{ upsertedWrites: Set<number> }>;
} {
  /**
   * The single permission mutation primitive. One CAS changes bits and metadata
   * together. Retry only THIS document, never documents that already completed.
   * Deletion wins over a pending mutation: never retarget it to a replacement ACL.
   * Transaction conflicts and ambiguous write failures propagate to the caller;
   * only a definite zero-match result is retried here.
   */
  async function mutatePermissionEntry(
    initial: Entry,
    identity: Record<string, unknown>,
    transform: (bits: number) => number,
    metadata: Record<string, unknown>,
    maxAttempts: number,
    tx?: Tx,
  ): Promise<IAclEntry | null> {
    let current: Entry | undefined = initial;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (current == null) return null;
      const observed = current.permBits;
      const permBits = permissionMask(transform(permissionMask(observed)));
      const guard: Record<string, unknown> = { ...identity, _id: current._id };
      // Bind the guard to the snapshot's role/audit state as well as its bits.
      for (const key of ['permBits', 'roleId', 'grantedBy', 'grantedAt']) {
        const value = (current as Record<string, unknown>)[key];
        guard[key] = value === undefined ? { $exists: false } : value;
      }
      const matched = await steps.updateGuarded(guard, { ...metadata, permBits }, tx);
      if (matched === 1) {
        return steps.toEntry({ ...current, ...metadata, permBits });
      }
      [current] = await steps.readEntries({ ...identity, _id: initial._id }, tx);
    }
    if (current == null) return null;
    throw new Error(
      `Permission write conflict: permBits guard did not hold after ${maxAttempts} attempts`,
    );
  }

  async function modifyEntryBits(
    identity: Record<string, unknown>,
    addBits: number | null | undefined,
    removeBits: number | null | undefined,
    tx?: Tx,
    maxAttempts?: number,
  ): Promise<IAclEntry | null> {
    const addMask = permissionMask(addBits ?? 0);
    const removeMask = permissionMask(removeBits ?? 0);
    const attempts = permissionWriteAttemptsSchema.parse(maxAttempts);
    const [entry] = await steps.readEntries(identity, tx);
    if (entry == null) return null;
    if (addMask === 0 && removeMask === 0) return steps.toEntry(entry);
    return mutatePermissionEntry(
      entry,
      identity,
      (bits) => (bits | addMask) & ~removeMask,
      {},
      attempts,
      tx,
    );
  }

  /**
   * Process each observed ACL once, including duplicates. Completion is tracked
   * per document; a later failure may leave earlier writes committed on standalone
   * databases and reports that fact without replaying them. This is not a batch transaction.
   */
  async function replaceRoleBits(
    writes: RoleBitsWrite[],
    options?: { tx?: Tx; maxAttempts?: number },
  ): Promise<{ upsertedWrites: Set<number> }> {
    const maxAttempts = permissionWriteAttemptsSchema.parse(options?.maxAttempts);
    const tx = options?.tx;
    const upsertedWrites = new Set<number>();
    let completedEntries = 0;
    try {
      for (const [index, write] of writes.entries()) {
        const roleOnly = permissionMask(write.roleBits) & RoleBits.OWNER;
        let existing = await steps.readEntries(write.filter, tx);
        if (existing.length === 0) {
          const upserted = await steps.insertIfMissing(
            write.filter,
            { ...write.insert, ...write.metadata, permBits: roleOnly },
            tx,
          );
          if (upserted === 1) {
            upsertedWrites.add(index);
            completedEntries++;
            continue;
          }
          // Another writer created this identity first. Read and mutate that row,
          // rather than claiming that a no-op identity upsert applied our role.
          existing = await steps.readEntries(write.filter, tx);
          if (existing.length === 0) throw new Error('ACL disappeared during role insertion');
        }
        for (const entry of existing) {
          const updated = await mutatePermissionEntry(
            entry,
            write.filter,
            (bits) => (bits & ~RoleBits.OWNER) | roleOnly,
            write.metadata,
            maxAttempts,
            tx,
          );
          if (updated == null)
            throw new Error('ACL deleted during role update; permission was not recreated');
          completedEntries++;
        }
      }
      return { upsertedWrites };
    } catch (error) {
      // Preserve MongoDB error labels so the owner can retry/abort its transaction.
      if (error instanceof Error) {
        Object.assign(error, {
          completedEntries,
          transactional: steps.inTransaction(tx),
        });
        error.message += ` (${completedEntries} ACL writes completed before failure; transaction may roll back)`;
      }
      throw error;
    }
  }

  return { modifyEntryBits, replaceRoleBits };
}
