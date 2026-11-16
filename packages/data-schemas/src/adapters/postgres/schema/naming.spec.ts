import {
  shortHash,
  quoteLiteral,
  childTableName,
  quoteIdentifier,
  identifierBytes,
  columnNameForPath,
  shortenIdentifier,
  IdentifierRegistry,
  IDENTIFIER_MAX_BYTES,
  SchemaGenerationError,
} from './naming';

describe('PostgreSQL identifier naming', () => {
  it('names columns and child tables by their path with __ between segments', () => {
    expect(columnNameForPath('agentEventActor.contextMeta.fading.v')).toBe(
      'agentEventActor__contextMeta__fading__v',
    );
    expect(columnNameForPath('personalization._id')).toBe('personalization___id');
    expect(childTableName('conversations', 'codeWorkspaces')).toBe('conversations__codeWorkspaces');
    expect(childTableName('conversations', 'agentEventActor.skillManifest')).toBe(
      'conversations__agentEventActor__skillManifest',
    );
  });

  it('keeps identifiers of up to 63 bytes and shortens longer ones deterministically', () => {
    const exact = 'x'.repeat(IDENTIFIER_MAX_BYTES);
    expect(shortenIdentifier(exact)).toBe(exact);
    const long = 'conversations__agentEventActor__compactionSemanticIndex__entries';
    expect(identifierBytes(long)).toBe(64);
    const short = shortenIdentifier(long);
    expect(short).toBe(`${long.slice(0, 54)}_${shortHash(long)}`);
    expect(identifierBytes(short)).toBe(63);
    expect(shortenIdentifier(long)).toBe(short);
    expect(shortenIdentifier(`${long}x`)).not.toBe(short);
  });

  it('counts bytes, not characters, and never splits a character', () => {
    const name = `${'a'.repeat(53)}é${'b'.repeat(20)}`;
    const short = shortenIdentifier(name);
    expect(identifierBytes(short)).toBeLessThanOrEqual(IDENTIFIER_MAX_BYTES);
    expect(short.startsWith(`${'a'.repeat(53)}_`)).toBe(true);
    expect(identifierBytes(shortenIdentifier('é'.repeat(40)))).toBeLessThanOrEqual(63);
  });

  it('quotes identifiers and literals', () => {
    expect(quoteIdentifier('a"b')).toBe('"a""b"');
    expect(quoteLiteral("it's")).toBe("'it''s'");
  });

  it('detects collisions and over-long names', () => {
    const registry = new IdentifierRegistry('spec');
    registry.register('a___b', 'path a_.b');
    expect(registry.register('a___b', 'path a_.b')).toBe('a___b');
    expect(() => registry.register('a___b', 'path a._b')).toThrow(
      new SchemaGenerationError('spec: path a._b and path a_.b both map to the identifier "a___b"'),
    );
    expect(() => registry.register('x'.repeat(64), 'long')).toThrow(/longer than 63 bytes/);
  });
});
