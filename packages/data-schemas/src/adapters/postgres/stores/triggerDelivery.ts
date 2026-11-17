/**
 * The PostgreSQL `TriggerDeliveryStore` (`~/ports/triggerDelivery`) on the
 * `agenttriggerdeliveries` table (with its `history` and `actorDetachedActionHistory` child
 * tables), the lane table `agenttriggerlanesequences` and the purge markers of
 * `agenttriggeruserpurges`: the delivery protocol of `~/methods/triggerDeliveryRules` on the
 * collection primitive. Must not import `mongoose`, `mongodb` or `bson`.
 *
 * - Each step of the protocol is one primitive operation, reached through the lean query subset
 *   the rules run on ({@link pgTriggerCollection}), so every compare-and-set the protocol states
 *   (`findOneAndUpdate` or `updateOne` with its fence) is one locked, rechecked write (§3.5): of
 *   concurrent claims of one row, lane reservations of one lane, receipt writes of one delivery,
 *   exactly one matches at write time and the others resolve the miss the protocol expects.
 * - `envelope` is `json` with the eight hinted paths of `schema/overrides.ts`: the protocol's
 *   equality and `$in` conditions on them are type-exact `#>` comparisons that the expression
 *   indexes serve; the listing's projection into it is applied after the fetch.
 * - The history caps (`$push` with `$each` and a negative `$slice`) are child-table statements
 *   (C2): the new elements are appended after the last `_ord`, then the elements before the kept
 *   tail are deleted, in the update's transaction.
 * - The receipt count by resolution is one hand-written `GROUP BY` through `storeWhere` (the
 *   tenant restriction of the plugin's `aggregate`).
 * - The owner's user record (its deletion fence) and the purge sweep's conversation check are
 *   read through the primitive in document mode, so they are scoped to the active tenant as the
 *   MongoDB models' reads are.
 */
import { sql } from 'kysely';
import type {
  TriggerDeliveryRulesDeps,
  TriggerDeliveryCollection,
  TriggerDeliveryUpdateOptions,
  TriggerDeliveryFilter,
  TriggerDeliveryQuery,
  TriggerDeliverySort,
} from '~/methods/triggerDeliveryRules';
import type { FieldDescriptor } from '../schema/descriptor';
import type { RecordTable } from '../records/tables';
import type { PgFindOptions } from '../collection';
import type { TriggerDeliveryStore } from '~/ports/triggerDelivery';
import type { IAgentTriggerDelivery } from '~/types';
import type { PostgresStoreContext } from './context';
import { createAgentTriggerDeliveryMethodsOnSteps } from '~/methods/triggerDeliveryRules';
import { StoreDuplicateKeyError } from '~/ports/storeErrors';
import { StoreQueryError } from '~/ports/query';
import { runStoreSql, storeWhere } from './context';
import { postgresStoreIds } from '../storeIds';

export const DELIVERIES = 'agenttriggerdeliveries';
export const LANES = 'agenttriggerlanesequences';
export const PURGES = 'agenttriggeruserpurges';

/** What a read being built carries until it runs. */
interface ReadOptions {
  sort?: TriggerDeliverySort;
  projection?: string;
  limit?: number;
}

/** A read (or single-record update) being built; runs once, on `lean` or when awaited. */
class PgTriggerQuery<R> implements TriggerDeliveryQuery<R> {
  private readonly options: ReadOptions = {};
  private result: Promise<R> | undefined;

  constructor(private readonly execute: (options: ReadOptions) => Promise<R>) {}

  sort(sort: TriggerDeliverySort): this {
    this.options.sort = sort;
    return this;
  }

  select(projection: string): this {
    this.options.projection = projection;
    return this;
  }

  limit(limit: number): this {
    this.options.limit = limit;
    return this;
  }

  read(): this {
    return this;
  }

  lean<T = R>(): Promise<T> {
    return this.run() as unknown as Promise<T>;
  }

  then<A = R, B = never>(
    onFulfilled?: ((value: R) => A | PromiseLike<A>) | null,
    onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): Promise<A | B> {
    return this.run().then(onFulfilled, onRejected);
  }

  private run(): Promise<R> {
    this.result ??= this.execute(this.options);
    return this.result;
  }
}

/** The find options of a built read. */
function findOptions(options: ReadOptions): PgFindOptions {
  return {
    ...(options.sort != null && { sort: options.sort }),
    ...(options.projection != null && { projection: options.projection }),
    ...(options.limit != null && { limit: options.limit }),
  };
}

/** The primitive's update options for the protocol's (MongoDB-spelled) ones. */
function updateOptions(options: TriggerDeliveryUpdateOptions = {}) {
  return {
    ...(options.sort != null && { sort: options.sort }),
    ...(options.upsert === true && { upsert: true }),
    ...(options.timestamps === false && { timestamps: false }),
  };
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value != null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;

/**
 * The conditions equivalent to equality of the subdocument `field` with `value` (MongoDB casts
 * such a value through the subdocument schema and compares it whole; the translator refuses
 * equality with an object): the object present, each declared leaf equal to the value's (a leaf
 * the value lacks absent, one it holds as `null` stored as `null`), nested objects alike.
 */
function objectEquality(
  field: Extract<FieldDescriptor, { kind: 'object' }>,
  value: Record<string, unknown>,
): TriggerDeliveryFilter[] {
  const conditions: TriggerDeliveryFilter[] = [{ [field.path]: { $exists: true } }];
  for (const child of field.fields) {
    const key = child.path.slice(field.path.length + 1);
    const leaf = value[key];
    if (leaf === undefined) {
      conditions.push({ [child.path]: { $exists: false } });
    } else if (child.kind === 'object' && isPlainObject(leaf)) {
      conditions.push(...objectEquality(child, leaf));
    } else if (leaf === null) {
      conditions.push({ [child.path]: null }, { [child.path]: { $exists: true } });
    } else if (child.kind === 'scalar') {
      conditions.push({ [child.path]: leaf });
    } else {
      throw new StoreQueryError(
        `Comparing "${field.path}" with a value that sets "${child.path}" is not supported`,
      );
    }
  }
  return conditions;
}

/**
 * `filter` with every equality of a subdocument path with an object value (the exact receipt
 * replays compare `actorReceipt` whole) stated on its leaves, in `$and`/`$or`/`$nor` too.
 */
export function expandObjectEquality(
  table: RecordTable,
  filter: TriggerDeliveryFilter,
): TriggerDeliveryFilter {
  let expanded: TriggerDeliveryFilter | undefined;
  const and: TriggerDeliveryFilter[] = [];
  for (const [key, value] of Object.entries(filter)) {
    if ((key === '$and' || key === '$or' || key === '$nor') && Array.isArray(value)) {
      const branches = value.map((branch) =>
        expandObjectEquality(table, branch as TriggerDeliveryFilter),
      );
      if (branches.some((branch, index) => branch !== value[index])) {
        expanded ??= { ...filter };
        expanded[key] = branches;
      }
      continue;
    }
    const field = key.startsWith('$') ? undefined : table.fields.get(key);
    if (
      field?.kind === 'object' &&
      isPlainObject(value) &&
      !Object.keys(value).some((name) => name.startsWith('$'))
    ) {
      expanded ??= { ...filter };
      delete expanded[key];
      and.push(...objectEquality(field, value));
    }
  }
  if (expanded == null) {
    return filter;
  }
  if (and.length > 0) {
    const existing = Array.isArray(expanded.$and) ? (expanded.$and as TriggerDeliveryFilter[]) : [];
    expanded.$and = [...existing, ...and];
  }
  return expanded;
}

/** The lean query subset the protocol runs on, over one primitive collection. */
export function pgTriggerCollection(
  context: PostgresStoreContext,
  name: string,
): TriggerDeliveryCollection {
  const collection = () => context.collections().collection(name);
  const query = <R>(execute: (options: ReadOptions) => Promise<R>) =>
    new PgTriggerQuery<R>(execute);
  const where = (filter: TriggerDeliveryFilter) =>
    expandObjectEquality(context.collections().tables.collection(name), filter);
  return {
    find: (filter) => query((options) => collection().find(where(filter), findOptions(options))),
    findOne: (filter) =>
      query((options) => {
        const { limit: _limit, ...rest } = findOptions(options);
        return collection().findOne(where(filter), rest);
      }),
    findById: (id) =>
      query(async (options) => {
        if (id == null) {
          return null;
        }
        const { limit: _limit, ...rest } = findOptions(options);
        return collection().findOne({ _id: id }, rest);
      }),
    exists: (filter) => query(() => collection().exists(where(filter))),
    countDocuments: (filter) => collection().count(where(filter)),
    findOneAndUpdate: (filter, update, options = {}) =>
      query((read) =>
        collection().findOneAndUpdate(where(filter), update, {
          ...updateOptions(options),
          returnDocument: options.new === true ? 'after' : 'before',
          ...(read.projection != null && { projection: read.projection }),
        }),
      ),
    updateOne: (filter, update, options) =>
      collection().updateOne(where(filter), update, updateOptions(options)),
    updateMany: (filter, update, options) => {
      const { sort: _sort, ...rest } = updateOptions(options);
      return collection().updateMany(where(filter), update, rest);
    },
    deleteOne: (filter) => collection().deleteOne(where(filter)),
    deleteMany: (filter) => collection().deleteMany(where(filter)),
  };
}

export function createPostgresTriggerDeliveryStore(
  context: PostgresStoreContext,
  deps: TriggerDeliveryRulesDeps = {},
): TriggerDeliveryStore {
  const deliveries = () => context.collections().collection(DELIVERIES);

  /** `$group` by `actorReceipt.resolution` over the receipts of the active tenant. */
  async function countReceiptsByResolution() {
    const filter: TriggerDeliveryFilter = { actorReceipt: { $exists: true } };
    const where = storeWhere(context, DELIVERIES, filter);
    const { rows } = await runStoreSql<{ _id: string; count: string | number }>(
      context,
      sql`SELECT t."actorReceipt__resolution" AS "_id", count(*) AS "count" FROM "agenttriggerdeliveries" AS t WHERE ${where} GROUP BY t."actorReceipt__resolution"`,
    );
    return rows.map((row) => ({
      _id: row._id as NonNullable<IAgentTriggerDelivery['actorReceipt']>['resolution'],
      count: Number(row.count),
    }));
  }

  const store: TriggerDeliveryStore = createAgentTriggerDeliveryMethodsOnSteps(
    {
      deliveries: () => pgTriggerCollection(context, DELIVERIES),
      lanes: () => pgTriggerCollection(context, LANES),
      purges: () => pgTriggerCollection(context, PURGES),
      users: () => pgTriggerCollection(context, 'users'),
      conversations: () => pgTriggerCollection(context, 'conversations'),
      createDelivery: async (document) =>
        (await deliveries().insertOne(document)) as unknown as IAgentTriggerDelivery,
      buildIndexes: async () => undefined,
      countReceiptsByResolution,
      isDuplicateKey: (error) => error instanceof StoreDuplicateKeyError,
      isStoreId: (value) => postgresStoreIds.isValid(value),
    },
    deps,
  );
  return store;
}
