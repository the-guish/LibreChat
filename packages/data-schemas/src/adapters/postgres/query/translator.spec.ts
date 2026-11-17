import { SCHEMA_DESCRIPTOR } from '../schema/descriptor.generated';
import { UndeclaredPathError } from '../records/paths';
import { StoreQueryError } from '~/ports/query';
import { createQueryTranslator } from './index';
import { compileQuerySql, sql } from './sql';

/**
 * The translator's interface and its refusals, without a database (the PostgreSQL specs of this
 * folder check the SQL's results).
 */

const translator = createQueryTranslator(SCHEMA_DESCRIPTOR);
const ID = (n: number) => n.toString(16).padStart(24, '0');

describe('query translator', () => {
  it('casts values before translating, and binds every value as a parameter', () => {
    const compiled = compileQuerySql(
      translator.filter('conversations', { user: ID(1), title: "it's" }),
    );
    expect(compiled.text).toBe('("t"."user" = $1::text AND "t"."title" = $2::text)');
    expect(compiled.values).toEqual([ID(1), "it's"]);
  });

  it('takes the alias of the rows', () => {
    const { text } = compileQuerySql(
      translator.filter('messages', { user: ID(1) }, { alias: 'm' }),
    );
    expect(text).toBe('"m"."user" = $1::text');
  });

  it('translates a filter over child rows (filterOn)', () => {
    const child = translator.tables.table('users__favorites');
    const { text, values } = compileQuerySql(
      translator.filterOn(child, { agentId: 'agent_1' }, { alias: 'f' }),
    );
    expect(text).toBe('"f"."agentId" = $1::text');
    expect(values).toEqual(['agent_1']);
  });

  it('builds a whole read with the projection pushed down, the sort and the paging', () => {
    const read = translator.find('conversations', {
      filter: { user: ID(1) },
      projection: 'title',
      sort: { updatedAt: -1, _id: -1 },
      limit: 10,
      offset: 20,
    });
    expect(read.text).toBe(
      'SELECT "t"."_id" AS "_id", "t"."title" AS "title", "t"."_nulls" AS "_nulls", "t"."_extra" AS "_extra" ' +
        'FROM "conversations" AS "t" WHERE "t"."user" = $1::text ' +
        'ORDER BY "t"."updatedAt" DESC NULLS LAST, "t"."_id" DESC NULLS LAST LIMIT 10 OFFSET 20',
    );
    expect(read.values).toEqual([ID(1)]);
    expect(read.decode([{ _id: ID(2), title: 'x', _nulls: null, _extra: null }])).toEqual([
      { _id: ID(2), title: 'x' },
    ]);
  });

  it('composes fragments with compileQuerySql', () => {
    const where = translator.filter('messages', { conversationId: 'c1', isCreatedByUser: true });
    const { text, values } = compileQuerySql(
      sql`SELECT count(*) FROM "messages" AS "t" WHERE ${where}`,
    );
    expect(text).toContain('$1::text');
    expect(text).toContain('$2::boolean');
    expect(values).toEqual(['c1', true]);
  });

  it.each([
    ['$expr', { $expr: { $eq: ['$a', '$b'] } }],
    ['$where', { $where: 'true' }],
  ])('refuses %s', (_operator, filter) => {
    expect(() => translator.filter('conversations', filter)).toThrow(StoreQueryError);
  });

  it('refuses an undeclared path (R9) and equality with an object', () => {
    expect(() => translator.filter('conversations', { notAField: 1 })).toThrow(UndeclaredPathError);
    expect(() => translator.filter('agents', { edges: { to: 'a' } }, { cast: false })).toThrow(
      /object/,
    );
    expect(() =>
      translator.filter('conversations', { agentEventActor: { a: 1 } }, { cast: false }),
    ).toThrow(StoreQueryError);
  });

  it('refuses $options without $regex, and a $size that is not a count', () => {
    expect(() => translator.filter('conversations', { title: { $options: 'i' } })).toThrow(
      /\$options/,
    );
    expect(() =>
      translator.filter('conversations', { tags: { $size: -1 } }, { cast: false }),
    ).toThrow(/\$size/);
  });

  it('refuses sorts by an object or a subdocument array, and directions other than 1 and -1', () => {
    expect(() => translator.sort('conversations', { agentEventActor: 1 })).toThrow(StoreQueryError);
    expect(() => translator.sort('conversations', { codeWorkspaces: 1 })).toThrow(StoreQueryError);
    expect(() => translator.sort('conversations', { title: 'asc' })).toThrow(StoreQueryError);
  });

  it('pages with LIMIT and OFFSET, a limit or offset of 0 or less meaning none', () => {
    expect(compileQuerySql(translator.paging({ limit: 5, offset: 0 })).text).toBe(' LIMIT 5');
    expect(compileQuerySql(translator.paging({ limit: -1, offset: 3 })).text).toBe(' OFFSET 3');
    expect(compileQuerySql(translator.paging({})).text).toBe('');
    expect(() => translator.paging({ limit: 1.5 })).toThrow(StoreQueryError);
  });

  it('maps projections onto the record projection, and refuses mixing and collisions', () => {
    expect(translator.projection('users', 'name email').record).toEqual({
      include: ['name', 'email'],
    });
    expect(translator.projection('users', '-password -_id +totpSecret').record).toEqual({
      exclude: ['password', '_id'],
      includeHidden: ['totpSecret'],
    });
    expect(translator.projection('users', { _id: 1 }).record).toEqual({ include: ['_id'] });
    expect(() => translator.projection('users', 'name -email')).toThrow(StoreQueryError);
    expect(() => translator.projection('agents', 'edges edges.to')).toThrow(/collision/);
  });

  it('projects into json values after the fetch, keeping their key order', () => {
    const projection = translator.projection('agents', 'edges.to');
    expect(projection.record).toEqual({ include: ['edges'] });
    expect(
      projection.apply?.({
        _id: ID(1),
        edges: [{ from: 'a', to: 'b', z: 1 }, 'scalar', { to: ['c'], y: 2 }, { from: 'x' }],
      }),
    ).toEqual({ _id: ID(1), edges: [{ to: 'b' }, { to: ['c'] }, {}] });
    const exclusion = translator.projection('agents', '-edges.to');
    expect(exclusion.record).toEqual({});
    expect(exclusion.apply?.({ edges: [{ from: 'a', to: 'b' }, 'scalar'] })).toEqual({
      edges: [{ from: 'a' }, 'scalar'],
    });
  });
});
