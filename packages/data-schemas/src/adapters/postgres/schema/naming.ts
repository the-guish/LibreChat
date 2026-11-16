/**
 * Identifier naming of the PostgreSQL schema (docs/postgres-port/PHASE4.md §1.2 "Naming", §1.7
 * "Names"): how a collection, a declared path, a child or element table, an index and a
 * constraint are named, and how a name over PostgreSQL's 63-byte limit is shortened.
 *
 * - A column is its path with `.` replaced by `__`, case kept (`agentEventActor__contextMeta`,
 *   a subdocument `_id` gives `personalization___id`). A child or element table is
 *   `<table>__<path>` by the same rule.
 * - An identifier longer than 63 bytes (PostgreSQL's `NAMEDATALEN - 1`, past which the server
 *   silently truncates) becomes its first 54 bytes, `_` and the first 8 hex digits of the
 *   SHA-256 of the whole name: deterministic, and the descriptor records every mapping.
 * - Collisions are never resolved silently: {@link IdentifierRegistry} fails the generation
 *   naming both owners (indexes are the one exception, see `descriptor.ts`, which disambiguate
 *   by a hash of their definition before registering).
 *
 * Must not import `mongoose`, `mongodb` or `bson`.
 */
import { createHash } from 'node:crypto';

/** The longest identifier PostgreSQL keeps (`NAMEDATALEN - 1`), in bytes. */
export const IDENTIFIER_MAX_BYTES = 63;
/** How many bytes of a shortened identifier are kept before its hash. */
export const SHORTENED_PREFIX_BYTES = 54;
/** The separator between path segments in column and table names. */
export const PATH_SEPARATOR = '__';

/** Raised when the schema cannot be mapped (an unsupported shape, a collision, a stale override). */
export class SchemaGenerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaGenerationError';
  }
}

/** The UTF-8 byte length of an identifier. */
export function identifierBytes(name: string): number {
  return Buffer.byteLength(name, 'utf8');
}

/** The first 8 hex digits of the SHA-256 of `text`. */
export function shortHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 8);
}

/** The longest prefix of `name` of at most `maxBytes` UTF-8 bytes that ends on a character. */
function bytePrefix(name: string, maxBytes: number): string {
  let bytes = 0;
  let end = 0;
  for (const char of name) {
    const size = identifierBytes(char);
    if (bytes + size > maxBytes) {
      break;
    }
    bytes += size;
    end += char.length;
  }
  return name.slice(0, end);
}

/**
 * `name` when it fits in 63 bytes; otherwise its first 54 bytes (whole characters), `_` and the
 * 8-hex hash of the full name.
 */
export function shortenIdentifier(name: string): string {
  if (identifierBytes(name) <= IDENTIFIER_MAX_BYTES) {
    return name;
  }
  return `${bytePrefix(name, SHORTENED_PREFIX_BYTES)}_${shortHash(name)}`;
}

/** The column name of a path (segments relative to the table's row). */
export function columnNameForPath(path: string): string {
  return shortenIdentifier(path.split('.').join(PATH_SEPARATOR));
}

/** The name of the child or element table holding the array at `path` of `table`'s rows. */
export function childTableName(table: string, path: string): string {
  return shortenIdentifier(`${table}${PATH_SEPARATOR}${path.split('.').join(PATH_SEPARATOR)}`);
}

/** `name` as a double-quoted SQL identifier. */
export function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** `value` as a single-quoted SQL string literal (standard_conforming_strings is on). */
export function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Names registered in one namespace (a table's columns, a table's constraints, or the schema's
 * relations: tables, indexes and the indexes behind primary keys), each with its owner, so a
 * second owner of a name fails the generation with both named.
 */
export class IdentifierRegistry {
  private readonly owners = new Map<string, string>();

  constructor(private readonly namespace: string) {}

  /** Registers `name` for `owner`; throws when another owner holds it or it is too long. */
  register(name: string, owner: string): string {
    if (identifierBytes(name) > IDENTIFIER_MAX_BYTES) {
      throw new SchemaGenerationError(
        `${this.namespace}: identifier "${name}" (${owner}) is longer than ${IDENTIFIER_MAX_BYTES} bytes`,
      );
    }
    const current = this.owners.get(name);
    if (current !== undefined && current !== owner) {
      throw new SchemaGenerationError(
        `${this.namespace}: ${owner} and ${current} both map to the identifier "${name}"`,
      );
    }
    this.owners.set(name, owner);
    return name;
  }

  /** Whether `name` is taken. */
  has(name: string): boolean {
    return this.owners.has(name);
  }
}
