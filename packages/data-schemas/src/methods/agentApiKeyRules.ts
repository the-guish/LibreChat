/**
 * The agent API key store's database-neutral rules (`AgentApiKeyStore`, `~/ports/agentApiKey`),
 * shared by every backend: the MongoDB methods (`./agentApiKey`) and the PostgreSQL store
 * (`adapters/postgres/stores/agentApiKey.ts`). Key generation (only the hash and a display prefix
 * are stored), expiry, and the list item a stored key is handed out as. Nothing here may import
 * `mongoose` or the MongoDB driver.
 */
import type { AgentApiKeyListItem, IAgentApiKey } from '~/types';
import { hashToken, getRandomValues } from '~/crypto';

const API_KEY_PREFIX = 'sk-';
const API_KEY_LENGTH = 32;

/** A new key, the hash it is stored and looked up by, and its display prefix. */
export async function generateApiKey(): Promise<{
  key: string;
  keyHash: string;
  keyPrefix: string;
}> {
  const randomPart = await getRandomValues(API_KEY_LENGTH);
  const key = `${API_KEY_PREFIX}${randomPart}`;
  const keyHash = await hashToken(key);
  const keyPrefix = key.slice(0, 8);
  return { key, keyHash, keyPrefix };
}

/** Whether the stored key has expired. */
export function isAgentApiKeyExpired(keyDoc: Pick<IAgentApiKey, 'expiresAt'>): boolean {
  return Boolean(keyDoc.expiresAt && new Date(keyDoc.expiresAt) < new Date());
}

/** A stored key as listed, without its hash. */
export function toAgentApiKeyListItem(
  key: Pick<IAgentApiKey, 'name' | 'keyPrefix' | 'lastUsedAt' | 'expiresAt' | 'createdAt'> & {
    _id?: unknown;
  },
): AgentApiKeyListItem {
  return {
    id: String(key._id),
    name: key.name,
    keyPrefix: key.keyPrefix,
    lastUsedAt: key.lastUsedAt,
    expiresAt: key.expiresAt,
    createdAt: key.createdAt,
  };
}
