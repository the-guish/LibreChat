/**
 * The assistant store's database-neutral rules (`AssistantStore`, `~/ports/assistant`), shared by
 * every backend: the MongoDB methods (`./assistant`) and the PostgreSQL store
 * (`adapters/postgres/stores/assistant.ts`). Nothing here may import `mongoose` or the MongoDB
 * driver.
 */
import { createHash } from 'node:crypto';
import type { AssistantQuery, IAssistant } from '~/types';
import { getTenantId, SYSTEM_TENANT_ID } from '~/config/tenantContext';
import { buildFilter, type FieldMap } from '~/utils/criteria';

const ASSISTANT_FIELDS: FieldMap<AssistantQuery> = {
  assistantId: 'assistant_id',
  user: 'user',
  avatarFilepath: 'avatar.filepath',
};

/** Translates domain assistant criteria into a filter of the store query language. */
export function assistantCriteria(query: AssistantQuery): Record<string, unknown> {
  return buildFilter<AssistantQuery, Record<string, unknown>>(query, ASSISTANT_FIELDS);
}

/** What an avatar update writes when it initializes or backfills the assistant's identity. */
export interface AssistantAvatarInsert {
  user: string;
  endpoint: string;
}

/**
 * Checks an avatar update's arguments (a nonempty `assistantId`, a nonempty `user` when given,
 * insert data naming the authorized user and an endpoint) and returns the insert data, if any.
 * Throws a `TypeError` otherwise.
 */
export function validateAssistantAvatarUpdate(
  query: { assistantId: string; user?: string },
  onInsert?: { user: string; endpoint: string },
): AssistantAvatarInsert | undefined {
  if (
    typeof query?.assistantId !== 'string' ||
    query.assistantId.trim().length === 0 ||
    !Object.prototype.hasOwnProperty.call(query, 'assistantId')
  ) {
    throw new TypeError('assistantId must be a nonempty string');
  }
  if (
    query.user !== undefined &&
    (typeof query.user !== 'string' ||
      query.user.trim().length === 0 ||
      !Object.prototype.hasOwnProperty.call(query, 'user'))
  ) {
    throw new TypeError('user must be a nonempty string');
  }

  if (
    onInsert !== undefined &&
    (typeof onInsert?.user !== 'string' ||
      onInsert.user.trim().length === 0 ||
      typeof onInsert.endpoint !== 'string' ||
      onInsert.endpoint.trim().length === 0 ||
      (query.user !== undefined && query.user !== onInsert.user))
  ) {
    throw new TypeError('Avatar insert data must identify the authorized user and endpoint');
  }

  return onInsert && { user: onInsert.user, endpoint: onInsert.endpoint };
}

/**
 * The id (24 hex characters) of the record an avatar update creates for an assistant that has
 * none, derived from the active tenant and the assistant id, so concurrent initializations on
 * every replica race for the same `_id`.
 */
export function assistantAvatarSeedId(assistantId: string): string {
  const tenantId = getTenantId();
  const tenant = tenantId && tenantId !== SYSTEM_TENANT_ID ? tenantId : null;
  return createHash('sha256')
    .update(JSON.stringify([tenant, assistantId]))
    .digest('hex')
    .slice(0, 24);
}

/** The fields an avatar update reads from the record it found. */
type AvatarReference = Pick<IAssistant, 'user' | 'endpoint' | 'avatar'>;

/** Whether the found record needs the write: another avatar, or identity to backfill. */
export function isAvatarUpdateNeeded(
  reference: AvatarReference,
  avatar: NonNullable<IAssistant['avatar']>,
  insertData: AssistantAvatarInsert | undefined,
): boolean {
  const missingUser = reference.user == null;
  const missingEndpoint = reference.endpoint == null || reference.endpoint === '';
  return !(
    (!insertData || (!missingUser && !missingEndpoint)) &&
    reference.avatar?.filepath === avatar.filepath &&
    reference.avatar.source === avatar.source
  );
}

/**
 * The identity guard of the avatar write (with the record's `_id`): the fields the decision was
 * made on still hold the values read.
 */
export function assistantAvatarGuard(
  reference: AvatarReference,
  assistantId: string,
): Record<string, unknown> {
  return {
    assistant_id: assistantId,
    user: reference.user ?? null,
    endpoint: reference.endpoint ?? null,
    avatar: reference.avatar ?? null,
  };
}

/** The avatar write: the avatar, and the user and endpoint the record lacks (insert data only). */
export function assistantAvatarUpdate(
  reference: AvatarReference,
  avatar: NonNullable<IAssistant['avatar']>,
  insertData: AssistantAvatarInsert | undefined,
): { $set: Record<string, unknown> } {
  const missingUser = reference.user == null;
  const missingEndpoint = reference.endpoint == null || reference.endpoint === '';
  return {
    $set: {
      avatar,
      ...(insertData && missingUser ? { user: insertData.user } : {}),
      ...(insertData && missingEndpoint ? { endpoint: insertData.endpoint } : {}),
    },
  };
}
