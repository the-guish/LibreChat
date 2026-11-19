import { Schema } from 'mongoose';
import type {
  FieldDescriptor,
  TableDescriptor,
  ColumnDescriptor,
  SchemaDescriptor,
} from './descriptor';
import type { SchemaOverrides } from './overrides';
import { buildSchemaDescriptor } from './descriptor';
import { NO_SCHEMA_OVERRIDES } from './overrides';
import { SchemaGenerationError } from './naming';
import { introspectSchema } from './generate';

/** The descriptor of one hand-made collection schema. */
function describeSchema(
  schema: Schema,
  options: {
    collection?: string;
    overrides?: Partial<SchemaOverrides>;
    primaryKey?: string[];
  } = {},
): SchemaDescriptor {
  const collection = options.collection ?? 'things';
  return buildSchemaDescriptor(
    [
      introspectSchema(schema, {
        collection,
        ...(options.primaryKey ? { primaryKey: options.primaryKey, kind: 'raw' as const } : {}),
      }),
    ],
    { ...NO_SCHEMA_OVERRIDES, ...options.overrides },
  );
}

function table(descriptor: SchemaDescriptor, name = 'things'): TableDescriptor {
  const found = descriptor.tables.find((entry) => entry.name === name);
  if (!found) throw new Error(`no table ${name}: ${descriptor.tables.map((t) => t.name).join()}`);
  return found;
}

function column(entry: TableDescriptor, name: string): ColumnDescriptor {
  const found = entry.columns.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`no column ${name}: ${entry.columns.map((c) => c.name).join()}`);
  return found;
}

function columnTypes(entry: TableDescriptor): Record<string, string> {
  return Object.fromEntries(entry.columns.map((c) => [c.name, c.sqlType]));
}

function findField(fields: FieldDescriptor[], path: string): FieldDescriptor | undefined {
  for (const candidate of fields) {
    if (candidate.path === path) return candidate;
    const nested = candidate.kind === 'object' ? findField(candidate.fields, path) : undefined;
    if (nested) return nested;
  }
  return undefined;
}

function field(fields: FieldDescriptor[], path: string): FieldDescriptor {
  const found = findField(fields, path);
  if (!found) throw new Error(`no field ${path}`);
  return found;
}

const sub = (definition: Record<string, unknown>, options: Record<string, unknown> = {}) =>
  new Schema(definition, { _id: false, ...options });

describe('PostgreSQL schema descriptor: §1.2 mapping rules on hand-made schemas', () => {
  describe('scalars → one column each', () => {
    const descriptor = describeSchema(
      new Schema({
        name: String,
        count: Number,
        flag: Boolean,
        at: Date,
        ref: Schema.Types.ObjectId,
        bytes: Buffer,
      }),
    );
    const things = table(descriptor);

    it('maps String, Number, Boolean, Date, ObjectId and Buffer to their column types', () => {
      expect(columnTypes(things)).toMatchObject({
        name: 'text COLLATE "C"',
        count: 'double precision',
        flag: 'boolean',
        at: 'timestamptz',
        ref: 'lc_object_id',
        bytes: 'bytea',
      });
      expect(field(things.fields, 'count')).toEqual({
        kind: 'scalar',
        path: 'count',
        column: 'count',
        type: 'number',
      });
    });

    it('makes an ObjectId _id the primary key', () => {
      expect(column(things, '_id')).toMatchObject({
        sqlType: 'lc_object_id',
        role: 'id',
        nullable: false,
      });
      expect(things.primaryKey).toEqual(['_id']);
      expect(things.idType).toBe('objectId');
    });

    it('keys a String-id collection by a text primary key', () => {
      const strings = table(describeSchema(new Schema({ _id: String, name: String })));
      expect(column(strings, '_id')).toMatchObject({ sqlType: 'text COLLATE "C"', role: 'id' });
      expect(strings.idType).toBe('string');
    });

    it('records lowercase, uppercase and trim on string leaves', () => {
      const things2 = table(
        describeSchema(
          new Schema({
            email: { type: String, lowercase: true, trim: true },
            code: { type: String, uppercase: true },
          }),
        ),
      );
      expect(field(things2.fields, 'email')).toMatchObject({ transforms: ['lowercase', 'trim'] });
      expect(field(things2.fields, 'code')).toMatchObject({ transforms: ['uppercase'] });
    });
  });

  describe('objects → flattened, with shape columns', () => {
    const descriptor = describeSchema(
      new Schema({
        profile: { city: String, geo: { lat: Number, lng: Number } },
        settings: sub({ theme: String, nested: sub({ depth: Number }) }),
        personalization: new Schema({ memories: Boolean }),
      }),
    );
    const things = table(descriptor);

    it('names leaf columns by their path with __ between segments', () => {
      expect(columnTypes(things)).toMatchObject({
        profile__city: 'text COLLATE "C"',
        profile__geo__lat: 'double precision',
        settings__theme: 'text COLLATE "C"',
        settings__nested__depth: 'double precision',
      });
    });

    it('gives each object path (nested object or subdocument) a boolean shape column', () => {
      for (const name of ['profile', 'profile__geo', 'settings', 'settings__nested']) {
        expect(column(things, name)).toMatchObject({ role: 'shape', sqlType: 'boolean' });
      }
      expect(field(things.fields, 'profile')).toMatchObject({ kind: 'object', subdocument: false });
      expect(field(things.fields, 'settings')).toMatchObject({ kind: 'object', subdocument: true });
    });

    it('maps a subdocument _id to <path>___id', () => {
      expect(column(things, 'personalization___id')).toMatchObject({ sqlType: 'lc_object_id' });
      expect(field(things.fields, 'personalization._id')).toMatchObject({
        column: 'personalization___id',
        type: 'objectId',
      });
    });

    it('keeps the path tree in schema order, objects at their first path', () => {
      expect(things.fields.map((entry) => entry.path)).toEqual([
        'profile',
        'settings',
        'personalization',
        '_id',
        '__v',
      ]);
    });
  });

  describe('arrays of scalars → PostgreSQL arrays, or element tables by override', () => {
    const schema = new Schema({
      tags: [String],
      scores: [Number],
      refs: [Schema.Types.ObjectId],
      days: [Date],
      nameTokens: { type: [String], select: false },
    });

    it('maps each scalar array to T[]', () => {
      const things = table(describeSchema(schema));
      expect(columnTypes(things)).toMatchObject({
        tags: 'text[] COLLATE "C"',
        scores: 'double precision[]',
        refs: 'lc_object_id[]',
        days: 'timestamptz[]',
      });
      expect(field(things.fields, 'tags')).toMatchObject({ kind: 'array', element: 'string' });
    });

    it('stores an overridden array in an element table with a count column', () => {
      const descriptor = describeSchema(schema, {
        overrides: {
          elementTables: [{ collection: 'things', path: 'nameTokens', reason: 'spec' }],
        },
      });
      const things = table(descriptor);
      expect(column(things, 'nameTokens')).toMatchObject({ role: 'count', sqlType: 'integer' });
      const elements = table(descriptor, 'things__nameTokens');
      expect(elements).toMatchObject({
        kind: 'element',
        parent: 'things',
        path: 'nameTokens',
        primaryKey: ['_parent', '_ord'],
        systemColumns: false,
      });
      expect(columnTypes(elements)).toEqual({
        _parent: 'lc_object_id',
        _ord: 'integer',
        value: 'text COLLATE "C"',
      });
      expect(field(things.fields, 'nameTokens')).toMatchObject({
        kind: 'elements',
        table: 'things__nameTokens',
        hidden: true,
      });
    });
  });

  describe('arrays of subdocuments → child tables', () => {
    const descriptor = describeSchema(
      new Schema({
        codeWorkspaces: [
          sub({
            environmentId: String,
            agentIds: [String],
            checkout: sub({ ref: String }),
            payload: Schema.Types.Mixed,
          }),
        ],
        actor: sub({ skillManifest: [sub({ name: String })] }),
      }),
    );

    it('creates <table>__<path> with _parent, _ord, the element columns, _nulls and _extra', () => {
      const child = table(descriptor, 'things__codeWorkspaces');
      expect(child).toMatchObject({
        kind: 'child',
        parent: 'things',
        path: 'codeWorkspaces',
        primaryKey: ['_parent', '_ord'],
        systemColumns: true,
      });
      expect(columnTypes(child)).toEqual({
        _parent: 'lc_object_id',
        _ord: 'integer',
        environmentId: 'text COLLATE "C"',
        agentIds: 'text[] COLLATE "C"',
        checkout: 'boolean',
        checkout__ref: 'text COLLATE "C"',
        payload: 'json',
        _nulls: 'text[] COLLATE "C"',
        _extra: 'jsonb',
      });
    });

    it('gives the parent an element-count shape column', () => {
      expect(column(table(descriptor), 'codeWorkspaces')).toMatchObject({
        role: 'count',
        sqlType: 'integer',
      });
    });

    it('names a child array under a subdocument by its whole path', () => {
      expect(table(descriptor, 'things__actor__skillManifest')).toMatchObject({
        parent: 'things',
        path: 'actor.skillManifest',
      });
      expect(column(table(descriptor), 'actor__skillManifest')).toMatchObject({ role: 'count' });
    });

    it('types _parent like the parent id (text for String ids)', () => {
      const strings = describeSchema(new Schema({ _id: String, items: [sub({ a: String })] }));
      expect(column(table(strings, 'things__items'), '_parent').sqlType).toBe('text COLLATE "C"');
    });

    it('maps an element _id to an lc_object_id column', () => {
      const withIds = describeSchema(new Schema({ items: [new Schema({ a: String })] }));
      expect(column(table(withIds, 'things__items'), '_id').sqlType).toBe('lc_object_id');
    });
  });

  describe('Mixed, arrays of Mixed and Map → json', () => {
    const things = table(
      describeSchema(
        new Schema({
          metadata: Schema.Types.Mixed,
          content: [{ type: Schema.Types.Mixed }],
          states: { type: Map, of: Boolean },
          bag: { type: Map, of: Schema.Types.Mixed },
        }),
      ),
    );

    it('uses json (not jsonb) columns', () => {
      expect(columnTypes(things)).toMatchObject({
        metadata: 'json',
        content: 'json',
        states: 'json',
        bag: 'json',
      });
    });

    it('records the kind and a Map value type', () => {
      expect(field(things.fields, 'metadata')).toMatchObject({ kind: 'json', json: 'mixed' });
      expect(field(things.fields, 'content')).toMatchObject({ kind: 'json', json: 'mixedArray' });
      expect(field(things.fields, 'states')).toMatchObject({ json: 'map', mapOf: 'boolean' });
      expect(field(things.fields, 'bag')).toMatchObject({ json: 'map', mapOf: 'mixed' });
    });

    it('can override a Mixed path to text (principalId)', () => {
      const overridden = table(
        describeSchema(new Schema({ principalId: Schema.Types.Mixed }), {
          overrides: {
            columnTypes: [
              {
                collection: 'things',
                path: 'principalId',
                type: 'objectIdOrString',
                reason: 'spec',
              },
            ],
          },
        }),
      );
      expect(column(overridden, 'principalId').sqlType).toBe('text COLLATE "C"');
      expect(field(overridden.fields, 'principalId')).toMatchObject({
        kind: 'scalar',
        type: 'objectIdOrString',
      });
    });

    it('adds a hint CHECK per hinted subpath', () => {
      const hinted = table(
        describeSchema(new Schema({ envelope: Schema.Types.Mixed }), {
          overrides: {
            jsonHints: [
              { collection: 'things', path: 'envelope', subpaths: ['event.type'], reason: 'spec' },
            ],
          },
        }),
      );
      expect(field(hinted.fields, 'envelope')).toMatchObject({ hints: ['event.type'] });
      expect(hinted.checks).toEqual([
        {
          name: 'things__envelope__event_type__hint',
          kind: 'jsonHint',
          column: 'envelope',
          path: 'event.type',
          expression:
            `jsonb_typeof(("envelope"::jsonb)) <> 'array' AND ` +
            `jsonb_typeof(("envelope"::jsonb) #> '{"event"}') <> 'array' AND ` +
            `jsonb_typeof((("envelope"::jsonb) #> '{"event","type"}')) NOT IN ('array', 'object')`,
        },
      ]);
    });
  });

  describe('missing versus null, strict mode and system fields', () => {
    const schema = new Schema(
      {
        tenantId: String,
        secret: { type: String, select: false },
        items: [sub({ a: String })],
      },
      { timestamps: true },
    );
    const descriptor = describeSchema(schema);
    const things = table(descriptor);

    it('ends every table and child table with _nulls text[] and _extra jsonb', () => {
      for (const entry of [things, table(descriptor, 'things__items')]) {
        expect(entry.columns.slice(-2)).toEqual([
          expect.objectContaining({
            name: '_nulls',
            sqlType: 'text[] COLLATE "C"',
            role: '_nulls',
          }),
          expect.objectContaining({ name: '_extra', sqlType: 'jsonb', role: '_extra' }),
        ]);
      }
    });

    it('stores __v as integer and records the version key and timestamps', () => {
      expect(column(things, '__v')).toMatchObject({ sqlType: 'integer', role: 'version' });
      expect(things.versionKey).toBe('__v');
      expect(things.timestamps).toEqual({ createdAt: 'createdAt', updatedAt: 'updatedAt' });
      expect(columnTypes(things)).toMatchObject({
        createdAt: 'timestamptz',
        updatedAt: 'timestamptz',
        tenantId: 'text COLLATE "C"',
      });
    });

    it('lists select: false paths as hidden ordinary columns', () => {
      expect(things.hiddenPaths).toEqual(['secret']);
      expect(field(things.fields, 'secret')).toMatchObject({ hidden: true, column: 'secret' });
    });

    it('maps a table keyed by its own columns without _id, _nulls or _extra', () => {
      const keyed = table(
        describeSchema(
          new Schema(
            { store: String, key: String, value: String },
            { _id: false, versionKey: false },
          ),
          { collection: 'kv', primaryKey: ['store', 'key'] },
        ),
        'kv',
      );
      expect(keyed.primaryKey).toEqual(['store', 'key']);
      expect(keyed.systemColumns).toBe(false);
      expect(keyed.columns.map((c) => c.name)).toEqual(['store', 'key', 'value']);
      expect(column(keyed, 'key')).toMatchObject({ role: 'id', nullable: false });
    });
  });

  describe('naming', () => {
    it('shortens identifiers over 63 bytes to 54 bytes, _ and an 8-hex hash', () => {
      const descriptor = describeSchema(
        new Schema({
          agentEventActor: sub({ compactionSemanticIndex: sub({ entries: [sub({ a: String })] }) }),
        }),
        { collection: 'conversations' },
      );
      const child = descriptor.tables.find((entry) => entry.kind === 'child')!;
      expect(child.name).toMatch(
        /^conversations__agentEventActor__compactionSemanticInde_[0-9a-f]{8}$/,
      );
      expect(Buffer.byteLength(child.name)).toBe(63);
      expect(child.path).toBe('agentEventActor.compactionSemanticIndex.entries');
    });
  });
});

describe('PostgreSQL schema descriptor: indexes (§1.7)', () => {
  it('maps btree keys with MongoDB null order and records the MongoDB name', () => {
    const schema = new Schema({ user: String, updatedAt: Date });
    schema.index({ user: 1, updatedAt: -1 });
    const [index] = table(describeSchema(schema)).indexes;
    expect(index).toEqual({
      name: 'things__user__updatedAt_desc',
      table: 'things',
      method: 'btree',
      keys: [
        { path: 'user', direction: 1, column: 'user' },
        { path: 'updatedAt', direction: -1, column: 'updatedAt' },
      ],
      unique: false,
      sources: [
        {
          mongoName: 'user_1_updatedAt_-1',
          fields: [
            ['user', 1],
            ['updatedAt', -1],
          ],
          unique: false,
          sparse: false,
        },
      ],
    });
  });

  it('maps a scalar-array key to GIN and the compound scalar keys to a separate btree', () => {
    const schema = new Schema({ tenantId: String, memberIds: [String] });
    schema.index({ memberIds: 1, tenantId: 1 });
    const indexes = table(describeSchema(schema)).indexes;
    expect(indexes.map(({ name, method, keys }) => ({ name, method, keys }))).toEqual([
      {
        name: 'things__tenantId',
        method: 'btree',
        keys: [{ path: 'tenantId', direction: 1, column: 'tenantId' }],
      },
      {
        name: 'things__memberIds__gin',
        method: 'gin',
        keys: [{ path: 'memberIds', direction: 1, column: 'memberIds' }],
      },
    ]);
  });

  it('indexes child-path keys on the child table, and merges identical SQL indexes', () => {
    const schema = new Schema({ tenantId: String, favorites: [sub({ agentId: String })] });
    schema.index({ tenantId: 1 });
    schema.index({ tenantId: 1, 'favorites.agentId': 1 });
    const descriptor = describeSchema(schema);
    const parent = table(descriptor).indexes;
    expect(parent).toHaveLength(1);
    expect(parent[0].sources.map((source) => source.mongoName)).toEqual([
      'tenantId_1',
      'tenantId_1_favorites.agentId_1',
    ]);
    expect(table(descriptor, 'things__favorites').indexes).toEqual([
      expect.objectContaining({
        name: 'things__favorites__agentId',
        keys: [{ path: 'agentId', direction: 1, column: 'agentId' }],
      }),
    ]);
  });

  it('indexes an element table on value', () => {
    const schema = new Schema({ tenantId: String, nameTokens: [String] });
    schema.index({ nameTokens: 1, tenantId: 1 });
    const descriptor = describeSchema(schema, {
      overrides: { elementTables: [{ collection: 'things', path: 'nameTokens', reason: 'spec' }] },
    });
    expect(table(descriptor, 'things__nameTokens').indexes).toEqual([
      expect.objectContaining({
        name: 'things__nameTokens__value',
        keys: [{ path: 'value', direction: 1, column: 'value' }],
      }),
    ]);
  });

  it('maps keys on json columns: GIN jsonb_path_ops, or btree expressions on hinted subpaths', () => {
    const schema = new Schema({
      edges: [{ type: Schema.Types.Mixed }],
      avatar: Schema.Types.Mixed,
    });
    schema.index({ 'edges.to': 1 });
    schema.index({ 'avatar.filepath': 1 });
    const indexes = table(
      describeSchema(schema, {
        overrides: {
          jsonHints: [
            { collection: 'things', path: 'avatar', subpaths: ['filepath'], reason: 'spec' },
          ],
        },
      }),
    ).indexes;
    expect(indexes.map(({ method, keys }) => ({ method, keys }))).toEqual([
      {
        method: 'gin',
        keys: [
          {
            path: 'edges',
            direction: 1,
            expression: '("edges"::jsonb)',
            opclass: 'jsonb_path_ops',
          },
        ],
      },
      {
        method: 'btree',
        keys: [
          {
            path: 'avatar.filepath',
            direction: 1,
            expression: `(("avatar"::jsonb) #> '{"filepath"}')`,
          },
        ],
      },
    ]);
  });

  it('maps unique, partial ($exists, equality, $type, null) and sparse rules to WHERE clauses', () => {
    const schema = new Schema({
      googleId: String,
      tenantId: String,
      slot: Number,
      deleting: Boolean,
      ownerSlot: Number,
      version: Number,
      scope: String,
    });
    schema.index(
      { googleId: 1, tenantId: 1 },
      { unique: true, partialFilterExpression: { googleId: { $exists: true } } },
    );
    schema.index(
      { slot: 1 },
      { unique: true, partialFilterExpression: { deleting: false, slot: { $exists: true } } },
    );
    schema.index({ ownerSlot: 1 }, { partialFilterExpression: { ownerSlot: { $type: 'number' } } });
    schema.index({ version: 1 }, { partialFilterExpression: { version: { $eq: null } } });
    schema.index({ scope: 1 }, { unique: true, sparse: true });
    const wheres = table(describeSchema(schema)).indexes.map(({ name, unique, where }) => ({
      name,
      unique,
      where,
    }));
    expect(wheres).toEqual([
      {
        name: 'things__googleId__tenantId__p',
        unique: true,
        where: `("googleId" IS NOT NULL OR 'googleId' = ANY ("_nulls"))`,
      },
      {
        name: 'things__slot__p',
        unique: true,
        where: `("deleting" = FALSE) AND (("slot" IS NOT NULL OR 'slot' = ANY ("_nulls")))`,
      },
      { name: 'things__ownerSlot__p', unique: false, where: `"ownerSlot" IS NOT NULL` },
      { name: 'things__version__p', unique: false, where: `"version" IS NULL` },
      {
        name: 'things__scope__p',
        unique: true,
        where: `("scope" IS NOT NULL OR 'scope' = ANY ("_nulls"))`,
      },
    ]);
  });

  it('records TTL rules (with their partial predicate) next to their btree', () => {
    const schema = new Schema({ expiresAt: Date, erasedAt: Date, erased: Boolean });
    schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    schema.index(
      { erasedAt: 1 },
      { expireAfterSeconds: 3600, partialFilterExpression: { erased: true } },
    );
    const things = table(describeSchema(schema));
    expect(things.ttl).toEqual([
      {
        column: 'expiresAt',
        path: 'expiresAt',
        expireAfterSeconds: 0,
        index: 'things__expiresAt',
        mongoName: 'expiresAt_1',
      },
      {
        column: 'erasedAt',
        path: 'erasedAt',
        expireAfterSeconds: 3600,
        where: `"erased" = TRUE`,
        index: 'things__erasedAt__p',
        mongoName: 'erasedAt_1',
      },
    ]);
  });

  it('disambiguates indexes whose names collide by a hash of their definition', () => {
    const schema = new Schema({ user: String, embedded: Boolean, searchable: Boolean });
    schema.index({ user: 1 }, { partialFilterExpression: { embedded: true } });
    schema.index({ user: 1 }, { partialFilterExpression: { searchable: true } });
    const names = table(describeSchema(schema)).indexes.map((index) => index.name);
    expect(names).toHaveLength(2);
    expect(names[0]).not.toBe(names[1]);
    for (const name of names) expect(name).toMatch(/^things__user__p_[0-9a-f]{8}$/);
  });
});

describe('PostgreSQL schema descriptor: unsupported shapes fail the generation', () => {
  const fails = (schema: Schema, message: RegExp, overrides?: Partial<SchemaOverrides>) => {
    expect(() => describeSchema(schema, { overrides })).toThrow(SchemaGenerationError);
    expect(() => describeSchema(schema, { overrides })).toThrow(message);
  };

  it('refuses an array of subdocuments inside another', () => {
    expect.hasAssertions();
    fails(
      new Schema({ outer: [sub({ inner: [sub({ a: String })] })] }),
      /array of subdocuments inside another/,
    );
    fails(
      new Schema({ outer: [sub({ object: sub({ inner: [sub({ a: String })] }) })] }),
      /array of subdocuments inside another/,
    );
  });

  it('refuses a unique index over a scalar array, a child path or a Mixed path', () => {
    expect.hasAssertions();
    const arrays = new Schema({ tags: [String] });
    arrays.index({ tags: 1 }, { unique: true });
    fails(arrays, /multikey uniqueness/);
    const children = new Schema({ items: [sub({ sku: String })] });
    children.index({ 'items.sku': 1 }, { unique: true });
    fails(children, /multikey uniqueness/);
    const mixed = new Schema({ edges: Schema.Types.Mixed });
    mixed.index({ 'edges.to': 1 }, { unique: true });
    fails(mixed, /multikey uniqueness/);
  });

  it('refuses __ in field names (but keeps the version key __v)', () => {
    expect.hasAssertions();
    fails(new Schema({ a__b: String }), /contains "__"/);
    fails(new Schema({ profile: { x__y: String } }), /contains "__"/);
    expect(() => describeSchema(new Schema({ a: String }))).not.toThrow();
  });

  it('refuses a field named like a system column', () => {
    expect.hasAssertions();
    for (const name of ['_parent', '_ord', '_nulls', '_extra']) {
      fails(new Schema({ [name]: String }), /collides with the system column/);
    }
    fails(new Schema({ items: [sub({ _ord: Number })] }), /collides with the system column/);
  });

  it('refuses two paths mapping to the same column name', () => {
    expect.hasAssertions();
    fails(
      new Schema({ a_: { b: String }, a: { _b: String } }),
      /both map to the identifier "a___b"/,
    );
  });

  it('refuses two tables mapping to the same name', () => {
    expect.hasAssertions();
    const parent = introspectSchema(new Schema({ b: [sub({ c: String })] }), { collection: 'a' });
    const clash = introspectSchema(new Schema({ c: String }), { collection: 'a__b' });
    expect(() => buildSchemaDescriptor([parent, clash])).toThrow(
      /both map to the identifier "a__b"/,
    );
  });

  it('refuses unsupported types, arrays of arrays and Maps of subdocuments', () => {
    expect.hasAssertions();
    fails(new Schema({ amount: Schema.Types.Decimal128 }), /unsupported schema type Decimal128/);
    fails(new Schema({ matrix: [[Number]] }), /arrays of arrays/);
    fails(
      new Schema({ byKey: { type: Map, of: sub({ a: String }) } }),
      /unsupported Map of object/,
    );
  });

  it('refuses index shapes PostgreSQL cannot serve', () => {
    expect.hasAssertions();
    const text = new Schema({ body: String });
    text.index({ body: 'text' });
    fails(text, /unsupported key type text/);
    const collated = new Schema({ name: String });
    collated.index({ name: 1 }, { collation: { locale: 'en' } });
    fails(collated, /collations are not supported/);
    const ttl = new Schema({ at: [Date] });
    ttl.index({ at: 1 }, { expireAfterSeconds: 1 });
    fails(ttl, /TTL index needs a single top-level Date key/);
    const undeclared = new Schema({ a: String });
    undeclared.index({ missing: 1 });
    fails(undeclared, /"missing" is not a declared path/);
    const crossTable = new Schema({ flag: Boolean, items: [sub({ sku: String })] });
    crossTable.index({ 'items.sku': 1 }, { partialFilterExpression: { flag: true } });
    fails(crossTable, /is not on the indexed table/);
    const exists = new Schema({ meta: Schema.Types.Mixed, n: Number });
    exists.index({ n: 1 }, { partialFilterExpression: { 'meta.x': { $exists: true } } });
    fails(exists, /unhinted Mixed subpath/);
    const wrongType = new Schema({ n: Number });
    wrongType.index({ n: 1 }, { partialFilterExpression: { n: { $type: 'string' } } });
    fails(wrongType, /never matches the number column/);
  });

  it('refuses a stale override', () => {
    expect.hasAssertions();
    fails(new Schema({ a: String }), /stale override: columnType on things.missing/, {
      columnTypes: [
        { collection: 'things', path: 'missing', type: 'objectIdOrString', reason: 'x' },
      ],
    });
    fails(new Schema({ a: String }), /stale override: collection "elsewhere"/, {
      elementTables: [{ collection: 'elsewhere', path: 'a', reason: 'x' }],
    });
    fails(new Schema({ a: String }), /expects a Mixed path/, {
      columnTypes: [{ collection: 'things', path: 'a', type: 'objectIdOrString', reason: 'x' }],
    });
    fails(new Schema({ items: [sub({ a: String })] }), /expects an array of scalars/, {
      elementTables: [{ collection: 'things', path: 'items', reason: 'x' }],
    });
  });
});
