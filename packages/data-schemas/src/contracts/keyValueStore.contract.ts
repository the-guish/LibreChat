/* eslint-disable jest/no-export -- This file is a shared contract-test suite, not a
   spec: it exports the suite factory that each backend's own spec imports. The rule
   guards against accidental exports from spec files. */
/**
 * The `KeyValueStore` contract (`~/ports/keyValueStore`), ported from
 * `adapters/mongo/keyValueStore.spec.ts`: what a store opened with
 * `DataStoreBackend.createKeyValueStore` does, in a plain store and with `largeValues`, on every
 * backend. Where an entry is kept (a collection or a bucket, a table row), the key and expiry
 * indexes and the removal of expired entries are each backend's own business and stay in the
 * adapters' specs. Nothing here may import `mongoose` or the MongoDB driver.
 */
import type { InfrastructureContractHarness } from './infrastructure';
import { KEY_VALUE_STORE_METHODS } from '~/ports/keyValueStore';
import { useInfrastructureHarness } from './infrastructure';

const UNICODE = 'déjà vu ✓ 😀 «ü»   "quoted" \\ back';

export function describeKeyValueStoreContract(harness: InfrastructureContractHarness): void {
  describe(`KeyValueStore contract: ${harness.name}`, () => {
    useInfrastructureHarness(harness);

    const open = (name: string, largeValues?: boolean) =>
      harness.backend().createKeyValueStore({ name, ...(largeValues ? { largeValues } : {}) });

    it('has every port method, each listed once', () => {
      const store = open('kv_methods');
      expect(Object.keys(store).sort()).toEqual([...KEY_VALUE_STORE_METHODS].sort());
      expect(new Set(KEY_VALUE_STORE_METHODS).size).toBe(KEY_VALUE_STORE_METHODS.length);
      expect(Object.keys(open('kv_methods', true)).sort()).toEqual(
        [...KEY_VALUE_STORE_METHODS].sort(),
      );
    });

    it('rejects every operation while the database is not connected, without reporting it', async () => {
      const onError = jest.fn();
      const store = harness.disconnectedBackend().createKeyValueStore({ name: 'kv', onError });
      await expect(store.get('a')).rejects.toThrow();
      await expect(store.getMany(['a'])).rejects.toThrow();
      await expect(store.set('a', 'b')).rejects.toThrow();
      await expect(store.delete('a')).rejects.toThrow();
      await expect(store.deleteMany(['a'])).rejects.toThrow();
      await expect(store.clear()).rejects.toThrow();
      await expect(store.has('a')).rejects.toThrow();
      expect(onError).not.toHaveBeenCalled();
    });

    describe('in a plain store', () => {
      it('stores one value per key, replacing it on set, and answers undefined for a missing key', async () => {
        const store = open('kv_entries');
        await store.set('ns:a', 'one', 60_000);
        await store.set('ns:b', 'two');
        await store.set('ns:a', 'uno', 60_000);
        expect(await store.get('ns:a')).toBe('uno');
        expect(await store.get('ns:b')).toBe('two');
        expect(await store.get('ns:missing')).toBeUndefined();
        expect(await store.getMany(['ns:a', 'ns:b'])).toEqual(['uno', 'two']);
      });

      it('replaces a value set with a ttl by one without, and the reverse', async () => {
        const store = open('kv_entries');
        await store.set('k', 'with ttl', 60_000);
        await store.set('k', 'without');
        expect(await store.get('k')).toBe('without');
        await store.set('k', 'with again', 60_000);
        expect(await store.get('k')).toBe('with again');
      });

      it('returns an expired entry that is not removed yet (Keyv checks the expiry itself)', async () => {
        const store = open('kv_entries');
        await store.set('soon', 'still here', 1);
        await new Promise((resolve) => setTimeout(resolve, 5));
        expect(await store.get('soon')).toBe('still here');
        expect(await store.has('soon')).toBe(true);
      });

      it('keeps values exactly: empty, long, JSON and non-ASCII text', async () => {
        const store = open('kv_entries');
        const json = JSON.stringify({ value: { a: [1, 'x', null] }, expires: 1_700_000_000_000 });
        const long = 'v'.repeat(200_000);
        await store.set('empty', '');
        await store.set('json', json);
        await store.set('long', long);
        await store.set('unicode', UNICODE);
        await store.set(UNICODE, 'unicode key');
        expect(await store.getMany(['empty', 'json', 'long', 'unicode', UNICODE])).toEqual([
          '',
          json,
          long,
          UNICODE,
          'unicode key',
        ]);
        expect(await store.has('empty')).toBe(true);
      });

      it('reads many keys in the order given, with undefined where none and repeats kept', async () => {
        const store = open('kv_entries');
        await store.set('a', '1');
        await store.set('c', '3');
        expect(await store.getMany(['c', 'b', 'a'])).toEqual(['3', undefined, '1']);
        expect(await store.getMany(['a', 'a'])).toEqual(['1', '1']);
        expect(await store.getMany([])).toEqual([]);
      });

      it('deletes a key, resolving whether an entry was removed', async () => {
        const store = open('kv_entries');
        await store.set('a', '1');
        expect(await store.has('a')).toBe(true);
        expect(await store.has('b')).toBe(false);
        expect(await store.delete('a')).toBe(true);
        expect(await store.delete('a')).toBe(false);
        expect(await store.has('a')).toBe(false);
        expect(await store.get('a')).toBeUndefined();
      });

      it('deletes many keys, resolving whether any was removed', async () => {
        const store = open('kv_entries');
        await store.set('b', '2');
        await store.set('c', '3');
        await store.set('d', '4');
        expect(await store.deleteMany(['b', 'c', 'x'])).toBe(true);
        expect(await store.deleteMany(['b', 'c'])).toBe(false);
        expect(await store.deleteMany([])).toBe(false);
        expect(await store.getMany(['b', 'c', 'd'])).toEqual([undefined, undefined, '4']);
      });

      it('clears the keys starting with the namespace, or every key', async () => {
        const store = open('kv_entries');
        await store.set('bans:1', 'x');
        await store.set('bansx:2', 'x');
        await store.set('other:3', 'x');
        await store.set('xbans:4', 'x');
        await store.clear('bans');
        expect(await store.getMany(['bans:1', 'bansx:2', 'other:3', 'xbans:4'])).toEqual([
          undefined,
          undefined,
          'x',
          'x',
        ]);
        await store.clear();
        expect(await store.getMany(['other:3', 'xbans:4'])).toEqual([undefined, undefined]);
        await expect(store.clear()).resolves.toBeUndefined();
      });

      it('shares entries with every store of the same name, and only with those', async () => {
        const store = open('kv_entries');
        const same = open('kv_entries');
        const other = open('kv_other');
        await store.set('shared', 'yes');
        await other.set('shared', 'other');
        expect(await same.get('shared')).toBe('yes');
        expect(await other.get('shared')).toBe('other');
        await same.clear();
        expect(await store.get('shared')).toBeUndefined();
        expect(await other.get('shared')).toBe('other');
        expect(await other.delete('shared')).toBe(true);
      });

      it('names an unnamed store keyv', async () => {
        await open('').set('k', 'unnamed');
        expect(await open('keyv').get('k')).toBe('unnamed');
      });
    });

    describe('with large values', () => {
      it('keeps each value, however large, under its key', async () => {
        const store = open('kv_large', true);
        const value = 'x'.repeat(300_000);
        await store.set('big', value, 60_000);
        await store.set('unicode', UNICODE);
        expect(await store.get('big')).toBe(value);
        expect(await store.get('unicode')).toBe(UNICODE);
        expect(await store.get('absent')).toBeUndefined();
        expect(await store.getMany(['big', 'absent', 'unicode'])).toEqual([
          value,
          undefined,
          UNICODE,
        ]);
        expect(await store.has('big')).toBe(true);
        expect(await store.has('absent')).toBe(false);
      });

      it('answers the latest value set under a key', async () => {
        const store = open('kv_large', true);
        await store.set('k', 'first');
        await store.set('k', 'second');
        expect(await store.get('k')).toBe('second');
      });

      it('deletes by key (true whether or not an entry existed) and many keys (whether any)', async () => {
        const store = open('kv_large', true);
        await store.set('one', 'a');
        await store.set('two', 'b');
        expect(await store.delete('one')).toBe(true);
        expect(await store.delete('one')).toBe(true);
        expect(await store.has('one')).toBe(false);
        expect(await store.deleteMany(['one'])).toBe(false);
        expect(await store.deleteMany(['two', 'one'])).toBe(true);
        expect(await store.has('two')).toBe(false);
      });

      it('clears every entry whatever the namespace', async () => {
        const store = open('kv_large', true);
        await store.set('ns:three', 'c');
        await store.set('other', 'd');
        await store.clear('ignored');
        expect(await store.getMany(['ns:three', 'other'])).toEqual([undefined, undefined]);
        await expect(store.clear()).resolves.toBeUndefined();
      });

      it('never shares entries with the plain store of the same name', async () => {
        const large = open('kv_both', true);
        const plain = open('kv_both');
        await large.set('k', 'large');
        await plain.set('k', 'plain');
        expect(await large.get('k')).toBe('large');
        expect(await plain.get('k')).toBe('plain');
        await large.clear();
        expect(await plain.get('k')).toBe('plain');
        expect(await open('kv_both', true).has('k')).toBe(false);
      });
    });
  });
}
