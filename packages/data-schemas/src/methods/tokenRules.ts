/**
 * The token store's database-neutral rules (`TokenStore`, `~/ports/token`), shared by every
 * backend: the MongoDB methods (`./token`) and the PostgreSQL store
 * (`adapters/postgres/stores/token.ts`). The AND lookups and deletes stated in the store query
 * language (normalized emails, explicitly absent fields matched by `null`, the OAuth credential
 * set selector), the expiries, and the scope compare-and-set. Nothing here may import `mongoose`
 * or the MongoDB driver.
 */
import type { TokenCreateData, TokenUpdateData } from '~/types';
import type { TokenStoreQuery } from '~/ports/token';

/** A filter or update in the store query language. */
export type TokenFilter = Record<string, unknown>;

/** The token metadata path the credential set selector compares. */
const CREDENTIAL_SET_PATH = 'metadata.credential_set_id';

/** A query's email as tokens store it: trimmed and lowercased (`null` kept). */
function normalizedEmail(email: string | null): string | null {
  return email === null ? null : email.trim().toLowerCase();
}

/**
 * The filter of `findToken`: every given field (AND). `userId` and `token` count only when
 * truthy; the other fields whenever they are given, `null` matching a token without one.
 */
export function findTokenFilter(query: TokenStoreQuery): { $and: TokenFilter[] } {
  const conditions: TokenFilter[] = [];

  if (query.userId) {
    conditions.push({ userId: query.userId });
  }
  if (query.token) {
    conditions.push({ token: query.token });
  }
  if (query.email !== undefined) {
    conditions.push({ email: normalizedEmail(query.email) });
  }
  if (query.type !== undefined) {
    conditions.push({ type: query.type });
  }
  if (query.scope !== undefined) {
    conditions.push({ scope: query.scope });
  }
  if (query.identifier !== undefined) {
    conditions.push({ identifier: query.identifier });
  }
  if (query.metadataCredentialSetId !== undefined) {
    conditions.push({ [CREDENTIAL_SET_PATH]: query.metadataCredentialSetId });
  }
  return { $and: conditions };
}

/**
 * The filter of `deleteTokens`: every field given (AND, `null` matching a token without one);
 * throws without any.
 */
export function deleteTokensFilter(query: TokenStoreQuery): { $and: TokenFilter[] } {
  const conditions: TokenFilter[] = [];

  if (query.userId !== undefined) {
    conditions.push({ userId: query.userId });
  }
  if (query.token !== undefined) {
    conditions.push({ token: query.token });
  }
  if (query.email !== undefined) {
    conditions.push({ email: normalizedEmail(query.email) });
  }
  if (query.type !== undefined) {
    conditions.push({ type: query.type });
  }
  if (query.scope !== undefined) {
    conditions.push({ scope: query.scope });
  }
  if (query.identifier !== undefined) {
    conditions.push({ identifier: query.identifier });
  }
  if (query.metadataCredentialSetId !== undefined) {
    conditions.push({ [CREDENTIAL_SET_PATH]: query.metadataCredentialSetId });
  }

  if (conditions.length === 0) {
    throw new Error('At least one query parameter must be provided');
  }
  return { $and: conditions };
}

/** The filter and update of `updateToken` (an `expiresIn` sets `expiresAt`). */
export function updateTokenWrite(
  query: TokenStoreQuery,
  updateData: TokenUpdateData,
): { filter: TokenFilter; update: TokenUpdateData } {
  const { metadataCredentialSetId, ...tokenQuery } = query;
  const filter: TokenFilter = { ...tokenQuery };
  if (metadataCredentialSetId !== undefined) {
    filter[CREDENTIAL_SET_PATH] = metadataCredentialSetId;
  }

  const update = { ...updateData };
  if (updateData?.expiresIn !== undefined) {
    update.expiresAt = new Date(Date.now() + updateData.expiresIn * 1000);
  }
  return { filter, update };
}

/** The record `createToken` stores: created now, expiring `expiresIn` seconds later. */
export function newTokenRecord<T extends { expiresIn: number }>(
  tokenData: T,
): T & { createdAt: Date; expiresAt: Date } {
  const currentTime = new Date();
  const expiresAt = new Date(currentTime.getTime() + tokenData.expiresIn * 1000);
  return {
    ...tokenData,
    createdAt: currentTime,
    expiresAt,
  };
}

/**
 * The compare-and-set of `replaceTokenIfCurrent`: the scoped token only while it is still the
 * expected one; with no expectation, an insert-only upsert that succeeds only when the scope is
 * absent (a concurrent insert loses on the scope's unique index).
 */
export function tokenReplacement<T extends Pick<TokenCreateData, 'token' | 'expiresIn'>>(
  scope: string,
  expectedToken: string | null,
  tokenData: T,
): { filter: TokenFilter; update: TokenFilter; upsert: boolean } {
  const currentTime = new Date();
  const { expiresIn, ...storedTokenData } = tokenData;
  const replacement = {
    ...storedTokenData,
    scope,
    createdAt: currentTime,
    expiresAt: new Date(currentTime.getTime() + expiresIn * 1000),
  };
  return {
    filter: { scope, token: expectedToken ?? tokenData.token },
    update: expectedToken === null ? { $setOnInsert: replacement } : { $set: replacement },
    upsert: expectedToken === null,
  };
}
