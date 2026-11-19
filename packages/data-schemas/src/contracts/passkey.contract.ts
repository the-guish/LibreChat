/* eslint-disable jest/no-export -- This file is a shared contract-test suite, not a
   spec: it exports the suite factory that each backend's own spec imports. The rule
   guards against accidental exports from spec files. */
/**
 * The `PasskeyStore` contract (`~/ports/passkey`), ported from `methods/passkey.spec.ts`: plain
 * passkey records (string ids, `Buffer` public keys), the deployment-wide unique credential id,
 * per-user reads and writes, and the signature-counter compare-and-swap. The cases that make the
 * counter write fail stub the MongoDB model and stay in the method spec. Nothing here may import
 * `mongoose` or the MongoDB driver.
 */
import type { ContractHarness } from './harness';
import type { PasskeyCreateData } from '~/types';
import { timeOf, useContractHarness } from './support';

export function describePasskeyContract(harness: ContractHarness): void {
  describe(`PasskeyStore contract: ${harness.name}`, () => {
    useContractHarness(harness);

    const userId = harness.ids.generate();
    const otherUserId = harness.ids.generate();
    const stores = () => harness.createStores().passkeys;
    const passkeyData = (overrides: Partial<PasskeyCreateData> = {}): PasskeyCreateData => ({
      user: userId,
      credentialId: 'credential-one',
      publicKey: Buffer.from([1, 2, 3]),
      counter: 0,
      transports: ['internal'],
      deviceType: 'multiDevice',
      backedUp: true,
      name: 'This device',
      ...overrides,
    });
    const storedPasskey = async (credentialId = 'credential-one') =>
      (await harness.readRaw('passkeys')).find((record) => record.credentialId === credentialId);

    describe('createPasskey', () => {
      it('stores the credential and resolves a plain record with its public key intact', async () => {
        const created = await stores().createPasskey(passkeyData());
        expect(created).toMatchObject({
          userId,
          credentialId: 'credential-one',
          counter: 0,
          transports: ['internal'],
          deviceType: 'multiDevice',
          backedUp: true,
          name: 'This device',
          lastUsedAt: null,
        });
        expect(Buffer.isBuffer(created.publicKey)).toBe(true);
        expect([...created.publicKey]).toEqual([1, 2, 3]);
        expect(typeof created.id).toBe('string');
        expect(created.createdAt).toBeInstanceOf(Date);
        expect(Object.getPrototypeOf(created)).toBe(Object.prototype);
        const stored = await storedPasskey();
        expect(stored).toMatchObject({ _id: created.id, user: userId });
        expect([...(stored?.publicKey as Buffer)]).toEqual([1, 2, 3]);
      });

      it('rejects a credential id that is already registered, for any user', async () => {
        await stores().createPasskey(passkeyData());
        const failure = await stores()
          .createPasskey(passkeyData({ user: otherUserId }))
          .catch((error: unknown) => error);
        expect(harness.errors.isDuplicateKey(failure)).toBe(true);
        expect(await harness.readRaw('passkeys')).toHaveLength(1);
      });
    });

    describe('findPasskeysByUser', () => {
      it("returns only the user's credentials, newest first, with Buffer keys", async () => {
        await harness.seedRaw('passkeys', [
          {
            ...passkeyData({ credentialId: 'older' }),
            _id: harness.ids.generate(),
            createdAt: new Date('2024-01-01T00:00:00.000Z'),
          },
          {
            ...passkeyData({ credentialId: 'newer', transports: undefined }),
            _id: harness.ids.generate(),
            createdAt: new Date('2024-02-01T00:00:00.000Z'),
          },
          {
            ...passkeyData({ credentialId: 'foreign', user: otherUserId }),
            _id: harness.ids.generate(),
            createdAt: new Date('2024-03-01T00:00:00.000Z'),
          },
        ]);
        const found = await stores().findPasskeysByUser(userId);
        expect(found.map((passkey) => passkey.credentialId)).toEqual(['newer', 'older']);
        expect(found.every((passkey) => Buffer.isBuffer(passkey.publicKey))).toBe(true);
        expect(Buffer.from(new Uint8Array(found[0].publicKey))).toEqual(Buffer.from([1, 2, 3]));
        expect(found[0].transports).toEqual([]);
      });
    });

    describe('findPasskeyByCredentialId', () => {
      it('finds the credential whoever owns it, or null', async () => {
        await stores().createPasskey(passkeyData({ user: otherUserId }));
        const found = await stores().findPasskeyByCredentialId('credential-one');
        expect(found).toMatchObject({ userId: otherUserId, credentialId: 'credential-one' });
        expect(Buffer.isBuffer(found?.publicKey)).toBe(true);
        expect(await stores().findPasskeyByCredentialId('unknown')).toBeNull();
      });
    });

    describe('countPasskeysByUser', () => {
      it("counts the user's credentials only", async () => {
        await stores().createPasskey(passkeyData({ credentialId: 'a' }));
        await stores().createPasskey(passkeyData({ credentialId: 'b' }));
        await stores().createPasskey(passkeyData({ credentialId: 'c', user: otherUserId }));
        expect(await stores().countPasskeysByUser(userId)).toBe(2);
        expect(await stores().countPasskeysByUser(harness.ids.generate())).toBe(0);
      });
    });

    describe('recordPasskeyUse', () => {
      it('advances the counter, stamps last use and refreshes the backup state', async () => {
        await stores().createPasskey(passkeyData({ counter: 5, backedUp: true }));
        const before = Date.now();
        expect(await stores().recordPasskeyUse('credential-one', 6, false)).toBe(true);
        const stored = await storedPasskey();
        expect(stored).toMatchObject({ counter: 6, backedUp: false });
        expect(timeOf(stored?.lastUsedAt)).toBeGreaterThanOrEqual(before);
        expect(
          (await stores().findPasskeyByCredentialId('credential-one'))?.lastUsedAt,
        ).toBeInstanceOf(Date);
      });

      it('refuses a counter that does not advance, changing nothing', async () => {
        await stores().createPasskey(passkeyData({ counter: 5 }));
        expect(await stores().recordPasskeyUse('credential-one', 5, false)).toBe(false);
        expect(await stores().recordPasskeyUse('credential-one', 3)).toBe(false);
        expect(await storedPasskey()).toMatchObject({ counter: 5, backedUp: true });
      });

      it('lets only one of two assertions at the same counter win', async () => {
        await stores().createPasskey(passkeyData({ counter: 1 }));
        const results = await Promise.all([
          stores().recordPasskeyUse('credential-one', 2),
          stores().recordPasskeyUse('credential-one', 2),
        ]);
        expect([...results].sort()).toEqual([false, true]);
      });

      it('restamps a counterless credential that stays at 0', async () => {
        await stores().createPasskey(passkeyData({ counter: 0 }));
        expect(await stores().recordPasskeyUse('credential-one', 0)).toBe(true);
        expect(await stores().recordPasskeyUse('credential-one', 0)).toBe(true);
        expect((await storedPasskey())?.lastUsedAt).toBeInstanceOf(Date);
      });

      it('resolves false, without throwing, when the credential is gone', async () => {
        expect(await stores().recordPasskeyUse('missing', 3)).toBe(false);
        expect(await stores().recordPasskeyUse('missing', 0)).toBe(false);
      });
    });

    describe('renamePasskey', () => {
      it("renames the user's credential, and refuses another user's", async () => {
        const created = await stores().createPasskey(passkeyData());
        expect(await stores().renamePasskey(created.id, otherUserId, 'Stolen')).toBeNull();
        const renamed = await stores().renamePasskey(created.id, userId, 'Laptop');
        expect(renamed).toMatchObject({ id: created.id, name: 'Laptop' });
        expect(Buffer.isBuffer(renamed?.publicKey)).toBe(true);
        expect((await storedPasskey())?.name).toBe('Laptop');
      });
    });

    describe('deletePasskey', () => {
      it("deletes the user's credential, and refuses another user's", async () => {
        const created = await stores().createPasskey(passkeyData());
        expect(await stores().deletePasskey(created.id, otherUserId)).toMatchObject({
          deletedCount: 0,
        });
        expect(await storedPasskey()).toBeDefined();
        expect(await stores().deletePasskey(created.id, userId)).toMatchObject({ deletedCount: 1 });
        expect(await harness.readRaw('passkeys')).toEqual([]);
      });
    });

    describe('deletePasskeysByUser', () => {
      it('clears every credential of the user and leaves others alone', async () => {
        await stores().createPasskey(passkeyData({ credentialId: 'a' }));
        await stores().createPasskey(passkeyData({ credentialId: 'b' }));
        await stores().createPasskey(passkeyData({ credentialId: 'c', user: otherUserId }));
        expect(await stores().deletePasskeysByUser(userId)).toMatchObject({ deletedCount: 2 });
        expect((await harness.readRaw('passkeys')).map((record) => record.credentialId)).toEqual([
          'c',
        ]);
      });
    });
  });
}
