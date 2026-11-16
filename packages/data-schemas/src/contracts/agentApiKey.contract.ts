/* eslint-disable jest/no-export -- This file is a shared contract-test suite, not a
   spec: it exports the suite factory that each backend's own spec imports. The rule
   guards against accidental exports from spec files. */
/**
 * The `AgentApiKeyStore` contract (`~/ports/agentApiKey`), ported from
 * `methods/agentApiKey.spec.ts`: keys issued in full once, stored as their SHA-256 hash with a
 * display prefix, validated while unexpired (recording their use in the background), listed
 * without hashes, and deleted per user. Nothing here may import `mongoose` or the MongoDB driver.
 */
import { createHash } from 'node:crypto';
import type { ContractHarness } from './harness';
import { idOf, timeOf, useContractHarness } from './support';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

export function describeAgentApiKeyContract(harness: ContractHarness): void {
  describe(`AgentApiKeyStore contract: ${harness.name}`, () => {
    useContractHarness(harness);

    const userId = harness.ids.generate();
    const otherUserId = harness.ids.generate();
    const stores = () => harness.createStores().agentApiKeys;
    const record = (overrides: Record<string, unknown> = {}) => ({
      _id: harness.ids.generate(),
      userId,
      name: 'key',
      keyHash: sha256(`sk-${Math.random()}`),
      keyPrefix: 'sk-abcde',
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    });
    /** Waits for the background use stamp `validateAgentApiKey` starts. */
    const waitForUse = async (keyId: string) => {
      for (let attempt = 0; attempt < 50; attempt++) {
        const stored = (await harness.readRaw('agentapikeys')).find((item) => item._id === keyId);
        if (stored?.lastUsedAt) {
          return stored.lastUsedAt;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return undefined;
    };

    describe('createAgentApiKey', () => {
      it('issues an sk- key in full once, storing only its hash and prefix', async () => {
        const expiresAt = new Date(Date.now() + 60_000);
        const created = await stores().createAgentApiKey({ userId, name: 'remote', expiresAt });
        expect(created.key).toMatch(/^sk-.{32,}$/);
        expect(created).toMatchObject({ name: 'remote', keyPrefix: created.key.slice(0, 8) });
        expect(timeOf(created.expiresAt)).toBe(expiresAt.getTime());
        expect(created.createdAt).toBeInstanceOf(Date);
        const [stored] = await harness.readRaw('agentapikeys');
        expect(stored).toMatchObject({
          _id: created.id,
          userId,
          name: 'remote',
          keyHash: sha256(created.key),
          keyPrefix: created.key.slice(0, 8),
        });
        expect(JSON.stringify(stored)).not.toContain(created.key);
      });

      it('issues a key without expiry, and a different key each time', async () => {
        const first = await stores().createAgentApiKey({ userId, name: 'a' });
        const second = await stores().createAgentApiKey({ userId, name: 'a', expiresAt: null });
        expect(first.key).not.toBe(second.key);
        expect(first.expiresAt ?? undefined).toBeUndefined();
        expect((await harness.readRaw('agentapikeys'))[0]).not.toHaveProperty('expiresAt');
      });
    });

    describe('validateAgentApiKey', () => {
      it('resolves the owner and id of a stored key, recording its use', async () => {
        const { key, id } = await stores().createAgentApiKey({ userId, name: 'remote' });
        const result = await stores().validateAgentApiKey(key);
        expect(idOf(harness, result?.userId)).toBe(userId);
        expect(idOf(harness, result?.keyId)).toBe(id);
        expect(await waitForUse(id)).toBeInstanceOf(Date);
      });

      it('reports an unknown or expired key as absent', async () => {
        await harness.seedRaw('agentapikeys', [
          record({ keyHash: sha256('sk-expired'), expiresAt: new Date(Date.now() - 1000) }),
        ]);
        expect(await stores().validateAgentApiKey('sk-unknown')).toBeNull();
        expect(await stores().validateAgentApiKey('sk-expired')).toBeNull();
      });
    });

    describe('listAgentApiKeys', () => {
      it("lists the user's keys newest first, without their hashes", async () => {
        await harness.seedRaw('agentapikeys', [
          record({ name: 'older', createdAt: new Date('2024-01-01T00:00:00.000Z') }),
          record({
            name: 'newer',
            createdAt: new Date('2024-02-01T00:00:00.000Z'),
            lastUsedAt: new Date('2024-02-02T00:00:00.000Z'),
          }),
          record({ name: 'foreign', userId: otherUserId }),
        ]);
        const keys = await stores().listAgentApiKeys(userId);
        expect(keys.map((item) => item.name)).toEqual(['newer', 'older']);
        expect(keys[0]).toMatchObject({ keyPrefix: 'sk-abcde' });
        expect(timeOf(keys[0].lastUsedAt)).toBe(new Date('2024-02-02T00:00:00.000Z').getTime());
        expect(typeof keys[0].id).toBe('string');
        for (const item of keys) {
          expect(item).not.toHaveProperty('keyHash');
          expect(item).not.toHaveProperty('key');
        }
      });
    });

    describe('getAgentApiKeyById', () => {
      it("returns the user's key without its hash, and null for another user's", async () => {
        const { id } = await stores().createAgentApiKey({ userId, name: 'remote' });
        const found = await stores().getAgentApiKeyById(id, userId);
        expect(found).toMatchObject({ id, name: 'remote' });
        expect(found).not.toHaveProperty('keyHash');
        expect(await stores().getAgentApiKeyById(id, otherUserId)).toBeNull();
        expect(await stores().getAgentApiKeyById(harness.ids.generate(), userId)).toBeNull();
      });
    });

    describe('deleteAgentApiKey', () => {
      it("deletes the user's key, and refuses another user's", async () => {
        const { id, key } = await stores().createAgentApiKey({ userId, name: 'remote' });
        expect(await stores().deleteAgentApiKey(id, otherUserId)).toBe(false);
        expect(await stores().deleteAgentApiKey(id, userId)).toBe(true);
        expect(await stores().deleteAgentApiKey(id, userId)).toBe(false);
        expect(await stores().validateAgentApiKey(key)).toBeNull();
      });
    });

    describe('deleteAllAgentApiKeys', () => {
      it('deletes every key of the user, counting them', async () => {
        await harness.seedRaw('agentapikeys', [
          record(),
          record(),
          record({ userId: otherUserId }),
        ]);
        expect(await stores().deleteAllAgentApiKeys(userId)).toBe(2);
        expect(await stores().deleteAllAgentApiKeys(userId)).toBe(0);
        expect((await harness.readRaw('agentapikeys')).map((item) => item.userId)).toEqual([
          otherUserId,
        ]);
      });
    });
  });
}
