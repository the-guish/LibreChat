import { Schema, Types } from 'mongoose';
import {
  mergeExtra,
  getExtraValue,
  unsetExtraValue,
  decodeExtraColumn,
  encodeExtraColumn,
} from './extra';
import { absenceSql, fromNullsColumn, presenceSql, toNullsColumn, updateNulls } from './nulls';
import { getNulReplacementCount, resetNulReplacementCount } from '../values';
import { decomposeRecord, insertStatements } from './decompose';
import { buildSchemaDescriptor } from '../schema/descriptor';
import { NO_SCHEMA_OVERRIDES } from '../schema/overrides';
import { introspectSchema } from '../schema/generate';
import { StoreQueryError } from '~/ports/query';
import { indexRecordTables } from './tables';

const sub = (definition: Record<string, unknown>) => new Schema(definition, { _id: false });

/** A hand-made collection `things` with every mapping rule. */
const thingSchema = new Schema(
  {
    name: { type: String },
    n: Number,
    flag: Boolean,
    at: Date,
    ref: Schema.Types.ObjectId,
    tags: [String],
    scores: [Number],
    profile: { city: String, geo: { lat: Number, lng: Number } },
    one: new Schema({ x: String }),
    items: [sub({ sku: String, qty: Number, meta: sub({ note: String }) })],
    mixed: Schema.Types.Mixed,
    list: [Schema.Types.Mixed],
    flags: { type: Map, of: Boolean },
    nameTokens: [String],
  },
  { timestamps: true },
);
const descriptor = buildSchemaDescriptor(
  [introspectSchema(thingSchema, { collection: 'things' })],
  {
    ...NO_SCHEMA_OVERRIDES,
    elementTables: [{ collection: 'things', path: 'nameTokens', reason: 'spec' }],
  },
);
const tables = indexRecordTables(descriptor);
const ID = '65a1b2c3d4e5f60718293a4b';

describe('decomposeRecord (document mode)', () => {
  it('fills columns, shape columns, child and element rows', () => {
    const decomposed = decomposeRecord(tables, 'things', {
      _id: new Types.ObjectId(ID),
      name: 'thing',
      n: -0,
      flag: false,
      at: new Date(5),
      ref: new Types.ObjectId(ID),
      tags: ['a', null],
      scores: [-0, 2],
      profile: { city: 'Paris', geo: {} },
      one: { x: 'y', _id: new Types.ObjectId(ID) },
      items: [{ sku: 's', qty: 1, meta: { note: 'n' } }, {}],
      mixed: { b: 1, a: new Date(0) },
      list: ['x', { k: Buffer.from('ab') }],
      flags: new Map([
        ['z', true],
        ['a', false],
      ]),
      nameTokens: ['th', 'thi'],
      __v: 0,
    });
    expect(decomposed.id).toBe(ID);
    expect(decomposed.row).toMatchObject({
      _id: ID,
      name: 'thing',
      n: '-0',
      flag: false,
      at: new Date(5),
      ref: ID,
      tags: ['a', null],
      scores: ['-0', 2],
      profile: true,
      profile__city: 'Paris',
      profile__geo: true,
      profile__geo__lat: null,
      one: true,
      one__x: 'y',
      one___id: ID,
      items: 2,
      mixed: '{"b":1,"a":{"$date":"1970-01-01T00:00:00.000Z"}}',
      list: '["x",{"k":{"$binary":"YWI="}}]',
      flags: '{"z":true,"a":false}',
      nameTokens: 2,
      __v: 0,
      _nulls: null,
      _extra: null,
    });
    expect(decomposed.children.map((child) => [child.table, child.rows.length])).toEqual([
      ['things__items', 2],
      ['things__nameTokens', 2],
    ]);
    expect(decomposed.children[0].rows[0]).toMatchObject({
      _parent: ID,
      _ord: 0,
      sku: 's',
      qty: 1,
      meta: true,
      meta__note: 'n',
    });
    expect(decomposed.children[0].rows[1]).toMatchObject({ _ord: 1, sku: null, meta: null });
    expect(decomposed.children[1].rows).toEqual([
      { _parent: ID, _ord: 0, value: 'th' },
      { _parent: ID, _ord: 1, value: 'thi' },
    ]);
    expect(decomposed.childTables).toEqual(['things__items', 'things__nameTokens']);
  });

  it('lists explicit nulls in _nulls (objects, arrays, child arrays, json) and omits missing paths', () => {
    const { row, children } = decomposeRecord(tables, 'things', {
      _id: ID,
      name: null,
      profile: { city: null, geo: null },
      one: null,
      items: [{ sku: null }],
      tags: null,
      mixed: null,
      nameTokens: null,
    });
    expect(row._nulls).toEqual([
      'name',
      'tags',
      'profile.city',
      'profile.geo',
      'one',
      'mixed',
      'nameTokens',
    ]);
    expect(row.profile).toBe(true);
    expect(row.items).toBe(1);
    expect(row.nameTokens).toBeNull();
    expect(children[0].rows[0]._nulls).toEqual(['sku']);
  });

  it('refuses values that do not fit and null child elements', () => {
    expect(() => decomposeRecord(tables, 'things', { _id: ID, n: 'five' })).toThrow(
      StoreQueryError,
    );
    expect(() => decomposeRecord(tables, 'things', { _id: ID, items: [null] })).toThrow(
      StoreQueryError,
    );
    expect(() => decomposeRecord(tables, 'things', { _id: ID, mixed: { $set: 1 } })).toThrow(
      StoreQueryError,
    );
    expect(() => decomposeRecord(tables, 'things', { name: 'x' })).toThrow(StoreQueryError);
  });

  it('puts undeclared keys back into _extra (a record computed from an assembled one)', () => {
    const { row, diverted } = decomposeRecord(tables, 'things', {
      _id: ID,
      legacy: { kept: true },
      profile: { city: 'x', old: 1 },
      items: [{ sku: 's', removed: 'r' }],
    });
    expect(decodeExtraColumn(row._extra)).toEqual({ legacy: { kept: true }, profile: { old: 1 } });
    expect(diverted).toEqual([
      { table: 'things', path: 'profile.old', reason: 'undeclared' },
      { table: 'things__items', path: 'removed', reason: 'undeclared' },
      { table: 'things', path: 'legacy', reason: 'undeclared' },
    ]);
  });
});

describe('decomposeRecord (raw mode)', () => {
  it('casts declared values like castObject and moves misfits to _extra (D7)', () => {
    const { row, children, diverted } = decomposeRecord(
      tables,
      'things',
      {
        _id: ID.toUpperCase(),
        n: '5',
        flag: 'yes',
        at: 'not a date',
        tags: 'single',
        items: [{ sku: 's' }, null],
        profile: 'not an object',
        mixed: { $legacy: 1 },
        flags: { a: 'true', b: 'maybe' },
        extraField: new Date(0),
      },
      { mode: 'raw' },
    );
    expect(row).toMatchObject({ _id: ID, n: 5, flag: true, tags: ['single'], items: null });
    expect(row.flags).toBe('{"a":true}');
    expect(children).toEqual([]);
    expect(decodeExtraColumn(row._extra)).toEqual({
      at: 'not a date',
      items: [{ sku: 's' }, null],
      profile: 'not an object',
      mixed: { $legacy: 1 },
      flags: { b: 'maybe' },
      extraField: new Date(0),
    });
    expect(diverted.map((entry) => entry.path)).toEqual([
      'at',
      'profile',
      'items',
      'mixed',
      'flags.b',
      'extraField',
    ]);
  });

  it('requires exact types with rawValues exact (the copy tool)', () => {
    const { row } = decomposeRecord(
      tables,
      'things',
      { _id: ID, n: '5', ref: ID.toUpperCase(), tags: 'single', flag: true },
      { mode: 'raw', rawValues: 'exact' },
    );
    expect(row).toMatchObject({ n: null, ref: null, tags: null, flag: true });
    expect(decodeExtraColumn(row._extra)).toEqual({
      n: '5',
      ref: ID.toUpperCase(),
      tags: 'single',
    });
  });
});

describe('U+0000 (D8)', () => {
  it('replaces U+0000 with U+FFFD in text, arrays, json, child rows and _extra, counting each string', () => {
    resetNulReplacementCount();
    const { row, children } = decomposeRecord(
      tables,
      'things',
      {
        _id: ID,
        name: 'a\u0000b',
        tags: ['\u0000'],
        mixed: { 'k\u0000': 'v\u0000' },
        items: [{ sku: '\u0000' }],
        undeclared: 'x\u0000',
      },
      { mode: 'raw' },
    );
    expect(row.name).toBe('a�b');
    expect(row.tags).toEqual(['�']);
    expect(row.mixed).toBe('{"k�":"v�"}');
    expect(children[0].rows[0].sku).toBe('�');
    expect(decodeExtraColumn(row._extra)).toEqual({ undeclared: 'x�' });
    expect(getNulReplacementCount()).toBe(6);
    decomposeRecord(tables, 'things', { _id: ID, name: '\u0000' }, { countNul: false });
    expect(getNulReplacementCount()).toBe(6);
    resetNulReplacementCount();
  });
});

describe('insertStatements', () => {
  it('inserts parents before children, every column, chunked under the parameter limit', () => {
    const records = Array.from({ length: 3 }, (_, index) =>
      decomposeRecord(tables, 'things', {
        _id: (index + 1).toString(16).padStart(24, '0'),
        items: [{ sku: 'a' }],
      }),
    );
    const statements = insertStatements(tables, records);
    expect(statements.map((statement) => statement.text.split(' (')[0])).toEqual([
      'INSERT INTO "things"',
      'INSERT INTO "things__items"',
    ]);
    const parentColumns = descriptor.tables[0].columns.length;
    expect(statements[0].values).toHaveLength(parentColumns * 3);
  });
});

describe('_nulls helpers', () => {
  it('lists, reads and updates explicit nulls, and states presence in SQL', () => {
    expect(toNullsColumn([])).toBeNull();
    expect(toNullsColumn(['a', 'a', 'b'])).toEqual(['a', 'b']);
    expect([...fromNullsColumn(null)]).toEqual([]);
    expect(updateNulls(['a.b', 'a.c', 'd'], 'a', false)).toEqual(['d']);
    expect(updateNulls(null, 'a', true)).toEqual(['a']);
    expect(updateNulls(['a'], 'a', false)).toBeNull();
    expect(presenceSql('a__b', 'a.b', { alias: 't' })).toBe(
      `("t"."a__b" IS NOT NULL OR 'a.b' = ANY ("t"."_nulls"))`,
    );
    expect(presenceSql('value', 'value', { systemColumns: false })).toBe(`"value" IS NOT NULL`);
    expect(absenceSql('a__b', 'a.b')).toBe(
      `("a__b" IS NULL AND NOT coalesce('a.b' = ANY ("_nulls"), false))`,
    );
  });
});

describe('_extra helpers', () => {
  it('encodes, merges after declared keys (declared values win), reads and unsets paths', () => {
    expect(encodeExtraColumn({})).toBeNull();
    const extra = decodeExtraColumn(
      encodeExtraColumn({ legacy: new Date(0), permissions: { AGENTS: { SHARED_GLOBAL: true } } }),
    );
    expect(extra).toEqual({
      legacy: new Date(0),
      permissions: { AGENTS: { SHARED_GLOBAL: true } },
    });
    const record = mergeExtra(
      { _id: 'x', permissions: { AGENTS: { USE: true } }, legacy: 'declared' },
      extra,
    );
    expect(Object.keys(record)).toEqual(['_id', 'permissions', 'legacy']);
    expect(record).toEqual({
      _id: 'x',
      permissions: { AGENTS: { USE: true, SHARED_GLOBAL: true } },
      legacy: 'declared',
    });
    expect(getExtraValue(extra, 'permissions.AGENTS.SHARED_GLOBAL')).toBe(true);
    expect(unsetExtraValue(extra, 'permissions.AGENTS.SHARED_GLOBAL')).toEqual({
      legacy: new Date(0),
    });
    expect(unsetExtraValue({ a: 1 }, 'a')).toBeNull();
    expect(() => encodeExtraColumn({ only: { $date: 'x' } })).toThrow(StoreQueryError);
  });
});
