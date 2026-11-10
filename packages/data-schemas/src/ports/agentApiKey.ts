/**
 * Agent API key store port: the API keys users create to call their agents from outside
 * LibreChat. Nothing here may import `mongoose`. Signatures are those of `AgentApiKeyMethods`
 * (`~/methods/agentApiKey`) with user and key ids stated as `IdLike`; `agentApiKey.spec.ts` fails
 * the typecheck if the MongoDB methods stop satisfying them.
 *
 * A key is stored only as its hash and an 8-character prefix; the full key is returned once, by
 * `createAgentApiKey`. Any store keeps that. Every operation on a key but validation is scoped
 * to its owner.
 */
import type { AgentApiKeyCreateData, AgentApiKeyCreateResult, AgentApiKeyListItem } from '~/types';
import type { IdLike, WithIdLike } from './common';
import { listPortMethods } from './common';

/** {@link AgentApiKeyCreateData} with its user id stated as `IdLike`. */
export type AgentApiKeyStoreCreateData = WithIdLike<AgentApiKeyCreateData, 'userId'>;

export interface AgentApiKeyStore {
  /** Issues a new key for the user, expiring at `expiresAt` when given; resolves it in full. */
  createAgentApiKey(data: AgentApiKeyStoreCreateData): Promise<AgentApiKeyCreateResult>;
  /**
   * The owner and id of the unexpired key `apiKey`, or `null`. Records the key's use without
   * waiting for the write.
   */
  validateAgentApiKey(apiKey: string): Promise<{ userId: IdLike; keyId: IdLike } | null>;
  /** The user's keys, newest first, without their hashes. */
  listAgentApiKeys(userId: IdLike): Promise<AgentApiKeyListItem[]>;
  /** Deletes the user's key `keyId`; false when the user has no such key. */
  deleteAgentApiKey(keyId: IdLike, userId: IdLike): Promise<boolean>;
  /** Deletes every key of the user; resolves how many. */
  deleteAllAgentApiKeys(userId: IdLike): Promise<number>;
  /** The user's key `keyId` without its hash, or `null`. */
  getAgentApiKeyById(keyId: IdLike, userId: IdLike): Promise<AgentApiKeyListItem | null>;
}

/** Every method of {@link AgentApiKeyStore}, for adapters and conformance checks. */
export const AGENT_API_KEY_STORE_METHODS: ReadonlyArray<keyof AgentApiKeyStore> =
  listPortMethods<AgentApiKeyStore>({
    createAgentApiKey: true,
    validateAgentApiKey: true,
    listAgentApiKeys: true,
    deleteAgentApiKey: true,
    deleteAllAgentApiKeys: true,
    getAgentApiKeyById: true,
  });
