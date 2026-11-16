/* eslint-disable jest/no-export -- This file is a shared contract-test suite, not a
   spec: it exports the suite factory that each backend's own spec imports. The rule
   guards against accidental exports from spec files. */
/**
 * The `UserKeyStore` contract (`~/ports/key`), ported from `methods/key.spec.ts`: the user's
 * provider keys, encrypted at rest (`v3` by default, the legacy fixed-IV format on request, and
 * legacy values still read), their JSON values, expiry, replacement and deletion. The encrypted
 * forms are `~/crypto`'s, shared by every backend. A backend's spec loads `./credentialsEnv`
 * first. Nothing here may import `mongoose` or the MongoDB driver.
 */
import { ErrorTypes } from 'librechat-data-provider';
import type { ContractHarness } from './harness';
import { encrypt } from '~/crypto';
import { timeOf, useContractHarness } from './support';

export function describeUserKeyContract(harness: ContractHarness): void {
  describe(`UserKeyStore contract: ${harness.name}`, () => {
    useContractHarness(harness);

    const userId = harness.ids.generate();
    const otherUserId = harness.ids.generate();
    const stores = () => harness.createStores().userKeys;
    const stored = async (name: string, owner = userId) =>
      (await harness.readRaw('keys')).find(
        (record) => record.name === name && record.userId === owner,
      );
    const noUserKey = JSON.stringify({ type: ErrorTypes.NO_USER_KEY });

    describe('updateUserKey', () => {
      it('writes the random-IV v3 format by default, and reads it back', async () => {
        await stores().updateUserKey({ userId, name: 'openAI', value: 'sk-test' });
        await stores().updateUserKey({ userId, name: 'anthropic', value: 'sk-test' });
        const first = await stored('openAI');
        const second = await stored('anthropic');
        expect(first?.value).toMatch(/^v3:[0-9a-f]{32}:[0-9a-f]+$/);
        expect(first?.value).not.toBe(second?.value);
        expect(await stores().getUserKey({ userId, name: 'openAI' })).toBe('sk-test');
      });

      it('writes the fixed-IV format only with writeFormat legacy', async () => {
        await stores().updateUserKey({
          userId,
          name: 'openAI',
          value: 'sk-test',
          writeFormat: 'legacy',
        });
        expect((await stored('openAI'))?.value).toMatch(/^[0-9a-f]+$/);
        expect(await stores().getUserKey({ userId, name: 'openAI' })).toBe('sk-test');
      });

      it('replaces the key, setting and clearing its expiry', async () => {
        const expiresAt = new Date(Date.now() + 60_000);
        await stores().updateUserKey({ userId, name: 'openAI', value: 'first', expiresAt });
        expect(timeOf((await stored('openAI'))?.expiresAt)).toBe(expiresAt.getTime());
        await stores().updateUserKey({ userId, name: 'openAI', value: 'second' });
        expect(await harness.readRaw('keys')).toHaveLength(1);
        expect(await stored('openAI')).not.toHaveProperty('expiresAt');
        expect(await stores().getUserKey({ userId, name: 'openAI' })).toBe('second');
      });
    });

    describe('getUserKey', () => {
      it('throws NO_USER_KEY when the user has no such key, even if another user has', async () => {
        await stores().updateUserKey({ userId: otherUserId, name: 'openAI', value: 'theirs' });
        await expect(stores().getUserKey({ userId, name: 'openAI' })).rejects.toThrow(noUserKey);
      });

      it('reads a legacy value written by earlier releases', async () => {
        await harness.seedRaw('keys', [
          {
            _id: harness.ids.generate(),
            userId,
            name: 'google',
            value: await encrypt('legacy-key'),
          },
        ]);
        expect(await stores().getUserKey({ userId, name: 'google' })).toBe('legacy-key');
      });
    });

    describe('getUserKeyValues', () => {
      it('parses the decrypted value as JSON', async () => {
        await harness.seedRaw('keys', [
          {
            _id: harness.ids.generate(),
            userId,
            name: 'google',
            value: await encrypt(JSON.stringify({ apiKey: 'legacy-key' })),
          },
        ]);
        expect(await stores().getUserKeyValues({ userId, name: 'google' })).toEqual({
          apiKey: 'legacy-key',
        });
      });

      it('throws INVALID_USER_KEY for a value that is not JSON, and NO_USER_KEY without one', async () => {
        await stores().updateUserKey({ userId, name: 'openAI', value: 'not json' });
        await expect(stores().getUserKeyValues({ userId, name: 'openAI' })).rejects.toThrow(
          JSON.stringify({ type: ErrorTypes.INVALID_USER_KEY }),
        );
        await expect(stores().getUserKeyValues({ userId, name: 'none' })).rejects.toThrow(
          noUserKey,
        );
      });
    });

    describe('getUserKeyExpiry', () => {
      it("reports the expiry, 'never' without one, and null without the key", async () => {
        const expiresAt = new Date(Date.now() + 60_000);
        await stores().updateUserKey({ userId, name: 'expiring', value: 'v', expiresAt });
        await stores().updateUserKey({ userId, name: 'forever', value: 'v' });
        const expiring = await stores().getUserKeyExpiry({ userId, name: 'expiring' });
        expect(timeOf(expiring.expiresAt)).toBe(expiresAt.getTime());
        expect(await stores().getUserKeyExpiry({ userId, name: 'forever' })).toEqual({
          expiresAt: 'never',
        });
        expect(await stores().getUserKeyExpiry({ userId, name: 'none' })).toEqual({
          expiresAt: null,
        });
      });
    });

    describe('deleteUserKey', () => {
      it('deletes the named key, or every key of the user with all', async () => {
        for (const [owner, name] of [
          [userId, 'openAI'],
          [userId, 'anthropic'],
          [userId, 'google'],
          [otherUserId, 'openAI'],
        ]) {
          await stores().updateUserKey({ userId: owner, name, value: 'v' });
        }
        await stores().deleteUserKey({ userId, name: 'openAI' });
        await expect(stores().getUserKey({ userId, name: 'openAI' })).rejects.toThrow(noUserKey);
        expect(await stores().getUserKey({ userId: otherUserId, name: 'openAI' })).toBe('v');
        await stores().deleteUserKey({ userId, all: true });
        expect((await harness.readRaw('keys')).map((record) => record.userId)).toEqual([
          otherUserId,
        ]);
      });
    });
  });
}
