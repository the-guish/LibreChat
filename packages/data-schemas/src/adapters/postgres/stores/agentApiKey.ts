/**
 * The PostgreSQL `AgentApiKeyStore` (`~/ports/agentApiKey`) on the `agentapikeys` table, through
 * the collection primitive, with the key generation and list items of
 * `~/methods/agentApiKeyRules`. Must not import `mongoose`, `mongodb` or `bson`.
 *
 * As on MongoDB: only the key's hash and display prefix are stored; `validateAgentApiKey`
 * records the key's use without waiting for the write (a failure is logged); ids are 24-hex
 * strings (R7).
 */
import type { AgentApiKeyStore } from '~/ports/agentApiKey';
import type { PostgresStoreContext } from './context';
import type { IAgentApiKey } from '~/types';
import {
  generateApiKey,
  isAgentApiKeyExpired,
  toAgentApiKeyListItem,
} from '~/methods/agentApiKeyRules';
import logger from '~/config/winston';
import { hashToken } from '~/crypto';

type AgentApiKeyRecord = IAgentApiKey & Record<string, unknown>;

export function createPostgresAgentApiKeyStore(context: PostgresStoreContext): AgentApiKeyStore {
  const keys = () => context.collections().collection<AgentApiKeyRecord>('agentapikeys');

  const store: AgentApiKeyStore = {
    async createAgentApiKey(data) {
      try {
        const { key, keyHash, keyPrefix } = await generateApiKey();
        const apiKeyDoc = await keys().insertOne({
          userId: data.userId,
          name: data.name,
          keyHash,
          keyPrefix,
          expiresAt: data.expiresAt || undefined,
        });
        return {
          id: String(apiKeyDoc._id),
          name: apiKeyDoc.name,
          keyPrefix,
          key,
          createdAt: apiKeyDoc.createdAt,
          expiresAt: apiKeyDoc.expiresAt,
        };
      } catch (error) {
        logger.error('[createAgentApiKey] Error creating API key:', error);
        throw error;
      }
    },

    async validateAgentApiKey(apiKey) {
      const keyHash = await hashToken(apiKey);
      const keyDoc = await keys().findOne({ keyHash });
      if (!keyDoc) {
        return null;
      }
      if (isAgentApiKeyExpired(keyDoc)) {
        return null;
      }
      keys()
        .updateOne({ _id: keyDoc._id }, { $set: { lastUsedAt: new Date() } })
        .catch((error: unknown) => {
          logger.error('[validateAgentApiKey] Error updating lastUsedAt:', error);
        });
      return { userId: String(keyDoc.userId), keyId: String(keyDoc._id) };
    },

    async listAgentApiKeys(userId) {
      try {
        const found = await keys().find({ userId }, { sort: { createdAt: -1 } });
        return found.map(toAgentApiKeyListItem);
      } catch (error) {
        logger.error('[listAgentApiKeys] Error listing API keys:', error);
        throw error;
      }
    },

    async deleteAgentApiKey(keyId, userId) {
      try {
        const result = await keys().deleteOne({ _id: keyId, userId });
        return result.deletedCount > 0;
      } catch (error) {
        logger.error('[deleteAgentApiKey] Error deleting API key:', error);
        throw error;
      }
    },

    async deleteAllAgentApiKeys(userId) {
      try {
        return (await keys().deleteMany({ userId })).deletedCount;
      } catch (error) {
        logger.error('[deleteAllAgentApiKeys] Error deleting all API keys:', error);
        throw error;
      }
    },

    async getAgentApiKeyById(keyId, userId) {
      try {
        const keyDoc = await keys().findOne({ _id: keyId, userId });
        return keyDoc ? toAgentApiKeyListItem(keyDoc) : null;
      } catch (error) {
        logger.error('[getAgentApiKeyById] Error getting API key:', error);
        throw error;
      }
    },
  };
  return store;
}
