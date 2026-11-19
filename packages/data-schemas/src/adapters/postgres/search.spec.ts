import { POSTGRES_SEARCH_KINDS, readPostgresSearchOptions } from './search';
import messageSchema from '~/schema/message';
import convoSchema from '~/schema/convo';

/** The schema paths the mongoMeili plugin indexes: those marked `meiliIndex`, and `user`. */
function meiliAttributes(schema: { obj: Record<string, unknown> }): string[] {
  const attributes = Object.entries(schema.obj)
    .filter(([, value]) => (value as { meiliIndex?: boolean } | null)?.meiliIndex === true)
    .map(([key]) => key);
  if (schema.obj.user && !attributes.includes('user')) {
    attributes.push('user');
  }
  return attributes;
}

describe('PostgreSQL search kinds', () => {
  it('index the attributes the mongoMeili plugin indexes, in schema order', () => {
    expect(POSTGRES_SEARCH_KINDS.messages.attributesToIndex).toEqual(
      meiliAttributes(messageSchema as unknown as { obj: Record<string, unknown> }),
    );
    expect(POSTGRES_SEARCH_KINDS.conversations.attributesToIndex).toEqual(
      meiliAttributes(convoSchema as unknown as { obj: Record<string, unknown> }),
    );
  });

  it('use the index names, keys and excluded paths of the models', () => {
    expect(POSTGRES_SEARCH_KINDS.messages).toMatchObject({
      indexName: 'messages',
      primaryKey: 'messageId',
      excludeFromIndexPath: 'subagentTask',
    });
    expect(POSTGRES_SEARCH_KINDS.conversations).toMatchObject({
      indexName: 'convos',
      primaryKey: 'conversationId',
      excludeFromIndexPath: 'subagentThread',
    });
  });

  it('turn MeiliSearch on with a host and a key, and the update hooks with SEARCH=true', () => {
    expect(readPostgresSearchOptions({})).toBeNull();
    expect(readPostgresSearchOptions({ MEILI_HOST: 'http://m' })).toBeNull();
    expect(readPostgresSearchOptions({ MEILI_HOST: 'http://m', MEILI_MASTER_KEY: 'k' })).toEqual({
      host: 'http://m',
      apiKey: 'k',
      searchEnabled: false,
    });
    expect(
      readPostgresSearchOptions({ MEILI_HOST: 'http://m', MEILI_MASTER_KEY: 'k', SEARCH: 'TRUE' }),
    ).toMatchObject({ searchEnabled: true });
  });
});
