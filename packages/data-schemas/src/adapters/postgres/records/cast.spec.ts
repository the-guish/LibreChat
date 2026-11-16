import { Types } from 'mongoose';
import type { FieldDescriptor, ScalarType } from '../schema/descriptor';
import type { RecordTable, RecordTables } from './tables';
import { getNulReplacementCount, resetNulReplacementCount } from '../values';
import { createRecordCaster, castScalar, canonicalizeValue } from './cast';
import { generateSchemaDescriptor } from '../schema/generate';
import { indexRecordTables, lastSegment } from './tables';
import { createSchemaEngine } from '../schema/engine';
import { StoreQueryError } from '~/ports/query';
import { UndeclaredPathError } from './paths';

const descriptor = generateSchemaDescriptor();
const tables = indexRecordTables(descriptor);
const engine = createSchemaEngine();
const caster = createRecordCaster(tables, { engine });

/**
 * mongoose's cast output in the store's canonical form, without the caster's own helpers; strings
 * with U+0000 as the store writes them (D8).
 */
function normalize(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.split('\u0000').join('\uFFFD');
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (value instanceof Date || value instanceof RegExp) {
    return value;
  }
  const bson = value as {
    _bsontype?: string;
    toHexString?: () => string;
    buffer?: Uint8Array;
    position?: number;
  };
  if (bson._bsontype === 'ObjectId' || bson._bsontype === 'ObjectID') {
    return bson.toHexString!();
  }
  if (bson._bsontype === 'Binary') {
    return Buffer.from(bson.buffer!.subarray(0, bson.position));
  }
  if (Buffer.isBuffer(value)) {
    return Buffer.from(value);
  }
  if (Array.isArray(value)) {
    return [...value].map(normalize);
  }
  if (value instanceof Map) {
    return Object.fromEntries([...value].map(([k, v]) => [k, normalize(v)]));
  }
  const plain =
    typeof (value as { toObject?: unknown }).toObject === 'function'
      ? (value as { toObject(o: object): Record<string, unknown> }).toObject({
          depopulate: true,
          flattenMaps: true,
        })
      : (value as Record<string, unknown>);
  return Object.fromEntries(Object.entries(plain).map(([k, v]) => [k, normalize(v)]));
}

type Outcome = { ok: unknown } | { error: true };

/** A copy of an input whose arrays and plain objects are new (mongoose casts in place). */
function cloneInput<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map(cloneInput) as T;
  }
  if (
    value !== null &&
    typeof value === 'object' &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, cloneInput(v)])) as T;
  }
  return value;
}

function run(fn: () => unknown): Outcome {
  try {
    return { ok: normalize(fn()) };
  } catch {
    return { error: true };
  }
}

function mongooseFilter(collection: string, filter: Record<string, unknown>): Outcome {
  return run(() => engine.model(collection).find(cloneInput(filter)).cast());
}

function mongooseUpdate(collection: string, update: Record<string, unknown>): Outcome {
  return run(() => {
    const query = engine.model(collection).updateOne({}, cloneInput(update)) as unknown as {
      getUpdate(): unknown;
      _castUpdate(update: unknown): unknown;
    };
    return query._castUpdate(query.getUpdate());
  });
}

function oursFilter(collection: string, filter: Record<string, unknown>): Outcome {
  try {
    return { ok: normalize(caster.castFilter(collection, cloneInput(filter))) };
  } catch (error) {
    if (!(error instanceof StoreQueryError)) throw error;
    return { error: true };
  }
}

function oursUpdate(collection: string, update: Record<string, unknown>): Outcome {
  try {
    return { ok: normalize(caster.castUpdate(collection, cloneInput(update))) };
  } catch (error) {
    if (!(error instanceof StoreQueryError)) throw error;
    return { error: true };
  }
}

/* -------------------------------------------------------------------------------------------- */
/* Generated inputs                                                                              */
/* -------------------------------------------------------------------------------------------- */

const HEX = '65a1b2c3d4e5f60718293a4b';

/** Inputs per type: values mongoose casts, values it refuses, and `null`. */
const INPUTS: Readonly<Record<ScalarType, readonly unknown[]>> = {
  string: ['  Mixed Case  ', 5, true, new Types.ObjectId(HEX), {}, [], null, 'a\u0000b'],
  number: ['5', ' 7 ', '', 'abc', true, 5.5, -0, new Date(0), {}, { _id: 3 }, null, 'Infinity'],
  boolean: ['true', 'yes', 'no', 1, 0, '0', 'x', null, false],
  date: [
    '2024-01-02T03:04:05.006Z',
    1700000000000,
    '1700000000000',
    true,
    'garbage',
    null,
    new Date(5),
  ],
  objectId: [
    HEX,
    HEX.toUpperCase(),
    new Types.ObjectId(HEX),
    'xyz',
    5,
    { _id: new Types.ObjectId(HEX) },
    null,
  ],
  buffer: [Buffer.from('ab'), 'text', [1, 2], null],
  /** A `Mixed` path in mongoose: only ids and strings are compared (others differ, R7). */
  objectIdOrString: ['principal', HEX, new Types.ObjectId(HEX), null],
};

/** A declared path of a collection, with what the caster needs to know. */
interface PathCase {
  collection: string;
  path: string;
  field: FieldDescriptor;
}

/** Every declared node of every collection, by document path (child paths through their array). */
function collectPaths(all: RecordTables): PathCase[] {
  const cases: PathCase[] = [];
  const walk = (
    collection: string,
    table: RecordTable,
    prefix: string,
    fields: readonly FieldDescriptor[],
  ) => {
    for (const field of fields) {
      const path = prefix ? `${prefix}.${lastSegment(field.path)}` : field.path;
      cases.push({ collection, path, field });
      if (field.kind === 'object') {
        walk(collection, table, path, field.fields);
      } else if (field.kind === 'children') {
        const child = all.table(field.table);
        walk(collection, child, path, child.descriptor.fields);
      }
    }
  };
  for (const root of all.roots) {
    if (root.descriptor.kind !== 'collection') continue;
    walk(root.descriptor.collection, root, '', root.descriptor.fields);
  }
  return cases;
}

const PATHS = collectPaths(tables);

/** The scalar cases: leaves and scalar arrays, with the element type. */
const SCALAR_CASES = PATHS.flatMap((entry) => {
  const { field } = entry;
  if (field.kind === 'scalar' && !field.system)
    return [{ ...entry, type: field.type, array: false }];
  if (field.kind === 'array' || field.kind === 'elements') {
    return [{ ...entry, type: field.element, array: true }];
  }
  return [];
});

describe('castScalar', () => {
  it('casts like mongoose per type', () => {
    expect(castScalar('number', '5')).toBe(5);
    expect(castScalar('number', '')).toBeNull();
    expect(castScalar('number', true)).toBe(1);
    expect(() => castScalar('number', 'x')).toThrow(StoreQueryError);
    expect(castScalar('boolean', 'yes')).toBe(true);
    expect(castScalar('boolean', '0')).toBe(false);
    expect(() => castScalar('boolean', 'maybe')).toThrow(StoreQueryError);
    expect(castScalar('date', '1700000000000')).toEqual(new Date(1700000000000));
    expect(castScalar('objectId', HEX.toUpperCase())).toBe(HEX);
    expect(castScalar('objectId', new Types.ObjectId(HEX))).toBe(HEX);
    expect(() => castScalar('objectId', 'abcdefghijkl')).toThrow(StoreQueryError);
    expect(castScalar('string', ' A ', { transforms: ['lowercase', 'trim'] })).toBe('a');
    expect(castScalar('string', 12)).toBe('12');
    expect(() => castScalar('string', {})).toThrow(StoreQueryError);
    expect(castScalar('objectIdOrString', new Types.ObjectId(HEX))).toBe(HEX);
    expect(castScalar('objectIdOrString', 'instance')).toBe('instance');
    expect(() => castScalar('objectIdOrString', 5)).toThrow(StoreQueryError);
    expect(() => castScalar('date', new Date(Date.UTC(-5000, 0, 1)))).toThrow(StoreQueryError);
  });

  it('replaces U+0000 in strings, counting it only for written values', () => {
    resetNulReplacementCount();
    expect(castScalar('string', 'a\u0000b')).toBe('a�b');
    expect(getNulReplacementCount()).toBe(0);
    expect(castScalar('string', 'a\u0000b', { countNul: true })).toBe('a�b');
    expect(getNulReplacementCount()).toBe(1);
    resetNulReplacementCount();
  });

  it('canonicalizes mongoose values deeply', () => {
    expect(
      canonicalizeValue({
        id: new Types.ObjectId(HEX),
        list: [new Map([['k', 1]])],
        when: new Date(1),
      }),
    ).toEqual({ id: HEX, list: [{ k: 1 }], when: new Date(1) });
  });
});

describe('the descriptor caster versus mongoose (generated inputs, every path of every model)', () => {
  it('covers every model and path kind', () => {
    const kinds = new Set(PATHS.map((entry) => entry.field.kind));
    expect([...kinds].sort()).toEqual([
      'array',
      'children',
      'elements',
      'json',
      'object',
      'scalar',
    ]);
    expect(new Set(PATHS.map((entry) => entry.collection)).size).toBe(53);
    expect(SCALAR_CASES.length).toBeGreaterThan(1000);
  });

  it('casts filter values as Query#cast does (equality, $in, $ne, $gt, $exists)', () => {
    let compared = 0;
    for (const { collection, path, type, array } of SCALAR_CASES) {
      for (const input of INPUTS[type]) {
        const filters: Array<Record<string, unknown>> = [
          { [path]: input },
          { [path]: { $in: [input, null] } },
          { [path]: { $ne: input } },
          { $or: [{ [path]: input }] },
        ];
        if (type !== 'boolean' && type !== 'buffer' && type !== 'objectIdOrString') {
          filters.push({ [path]: { $gt: input, $exists: 'yes' } });
        }
        if (array) {
          filters.push({ [path]: { $size: '2', $all: [input] } });
        }
        for (const filter of filters) {
          const expected = mongooseFilter(collection, filter);
          expect({ collection, filter, outcome: oursFilter(collection, filter) }).toEqual({
            collection,
            filter,
            outcome: expected,
          });
          compared++;
        }
      }
    }
    expect(compared).toBeGreaterThan(20000);
  }, 120_000);

  it('casts update values as mongoose update casting does ($set, $inc, $min/$max, $push, $addToSet, $pull, $pullAll)', () => {
    let compared = 0;
    for (const { collection, path, type, array } of SCALAR_CASES) {
      if (type === 'objectIdOrString') continue;
      for (const input of INPUTS[type]) {
        const updates: Array<Record<string, unknown>> = [
          { $set: { [path]: input } },
          { [path]: input },
        ];
        if (!array && !path.includes('.')) {
          updates.push({ $setOnInsert: { [path]: input } });
        }
        /**
         * mongoose walks a plain-object operand of `$inc`/`$min`/`$max` as nested paths and leaves
         * it uncast (MongoDB then refuses it); the caster refuses it at once.
         */
        const plainObject =
          input !== null &&
          typeof input === 'object' &&
          Object.getPrototypeOf(input) === Object.prototype;
        if (type === 'number' && !array && !plainObject) {
          updates.push({ $inc: { [path]: input } }, { $max: { [path]: input } });
        }
        if (type === 'date' && !array && !plainObject) {
          updates.push({ $min: { [path]: input } });
        }
        /** Pushing an array or an object into a scalar array is refused (arrays of arrays). */
        const element =
          input === null ||
          typeof input !== 'object' ||
          input instanceof Date ||
          input instanceof Types.ObjectId ||
          Buffer.isBuffer(input);
        if (array && !path.includes('.') && element) {
          updates.push(
            { $push: { [path]: input } },
            { $addToSet: { [path]: { $each: [input, input] } } },
            { $pull: { [path]: input } },
            { $pullAll: { [path]: [input] } },
            { $set: { [path]: [input] } },
          );
        }
        for (const update of updates) {
          const expected = mongooseUpdate(collection, update);
          expect({ collection, update, outcome: oursUpdate(collection, update) }).toEqual({
            collection,
            update,
            outcome: expected,
          });
          compared++;
        }
      }
    }
    expect(compared).toBeGreaterThan(10000);
  }, 120_000);

  it('casts Map values by their declared type and leaves Mixed alone, in filters and updates', () => {
    const cases = PATHS.filter((entry) => entry.field.kind === 'json');
    expect(cases.length).toBeGreaterThan(30);
    for (const { collection, path } of cases) {
      for (const input of ['5', 'yes', { b: 1, a: [HEX] }, null]) {
        for (const filter of [{ [path]: input }, { [`${path}.key`]: input }]) {
          expect({ filter, outcome: oursFilter(collection, filter) }).toEqual({
            filter,
            outcome: mongooseFilter(collection, filter),
          });
        }
        const update = { $set: { [`${path}.key`]: input } };
        expect({ update, outcome: oursUpdate(collection, update) }).toEqual({
          update,
          outcome: mongooseUpdate(collection, update),
        });
      }
    }
  });

  it('builds subdocuments of updates as mongoose does (defaults, _ids), through the engine', () => {
    /** Date defaults (`Date.now`) give the same value to both casts. */
    jest.useFakeTimers({ now: new Date('2024-05-06T07:08:09.010Z') });
    const cases = PATHS.filter(
      (entry) =>
        (entry.field.kind === 'object' && entry.field.subdocument) ||
        entry.field.kind === 'children',
    );
    expect(cases.length).toBeGreaterThan(40);
    for (const { collection, path, field } of cases) {
      const element = { unknownKey: 1 };
      const updates: Array<Record<string, unknown>> =
        field.kind === 'children'
          ? [
              { $push: { [path]: element } },
              { $set: { [path]: [element] } },
              { $addToSet: { [path]: { $each: [element] } } },
            ]
          : [{ $set: { [path]: element } }];
      for (const update of updates) {
        const expected = mongooseUpdate(collection, update);
        const actual = oursUpdate(collection, update);
        /** Generated subdocument `_id`s differ between the two casts. */
        const dropIds = (value: unknown): unknown =>
          JSON.parse(JSON.stringify(value), (key, item) => (key === '_id' ? undefined : item));
        expect({ update, outcome: dropIds(actual) }).toEqual({
          update,
          outcome: dropIds(expected),
        });
      }
    }
    jest.useRealTimers();
  });

  it('casts conditions inside $elemMatch on child arrays and scalar arrays', () => {
    const filter = {
      agentEventActorReconciliations: {
        $elemMatch: { observedAt: '2024-01-01', status: { $in: [5] } },
      },
      tags: { $elemMatch: { $in: [5], $ne: 'x' } },
    };
    expect(oursFilter('conversations', filter)).toEqual(mongooseFilter('conversations', filter));
  });

  it('casts positional and numeric update paths into child arrays', () => {
    for (const update of [
      { $set: { 'agentEventActorReconciliations.$.observedAt': '2024-01-01' } },
      { $set: { 'agentEventActorReconciliations.0.observedAt': 1700000000000 } },
      { $set: { 'agentEventActorReconciliations.$[held].status': 5 } },
    ]) {
      expect(oursUpdate('conversations', update)).toEqual(mongooseUpdate('conversations', update));
    }
  });

  it('strips undeclared update paths as mongoose strict does, or refuses or keeps them on request', () => {
    const update = { $set: { notDeclared: 1, title: 5 }, $unset: { isPublic: 1 } };
    expect(oursUpdate('conversations', update)).toEqual(mongooseUpdate('conversations', update));
    expect(() => caster.castUpdate('conversations', update, { undeclared: 'refuse' })).toThrow(
      UndeclaredPathError,
    );
    expect(
      caster.castUpdate('sharedlinks', { $unset: { isPublic: 1 } }, { undeclared: 'keep' }),
    ).toEqual({ $unset: { isPublic: 1 } });
  });

  it('refuses filters on undeclared paths (R9) and conditions outside its types', () => {
    expect(() => caster.castFilter('conversations', { notDeclared: 1 })).toThrow(
      UndeclaredPathError,
    );
    expect(() => caster.castFilter('conversations', { 'title.deeper': 1 })).toThrow(
      UndeclaredPathError,
    );
    expect(() => caster.castFilter('conversations', { $where: 'true' })).toThrow(StoreQueryError);
    expect(() => caster.castFilter('conversations', { agentEventActor: { a: 1 } })).toThrow(
      StoreQueryError,
    );
    expect(() => caster.castFilter('messages', { createdAt: { $regex: 'x' } })).toThrow(
      StoreQueryError,
    );
    expect(() =>
      caster.castUpdate('conversations', { $push: { tags: { $each: ['a'], $slice: 1 } } }),
    ).toThrow(StoreQueryError);
  });

  it('keeps $regex sources, RegExps and $options, and casts the language corpus forms', () => {
    const filter = {
      title: { $regex: '^A', $options: 'i' },
      conversationId: /x/i,
      $and: [{ tags: { $nin: ['A', null] } }, { createdAt: { $lte: '2024-01-01' } }],
    };
    expect(oursFilter('conversations', filter)).toEqual(mongooseFilter('conversations', filter));
    expect(caster.castFilter('conversations', { agentEventActorReconciliations: [] })).toEqual({
      agentEventActorReconciliations: [],
    });
  });
});
