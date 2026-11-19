import { Types } from 'mongoose';
import { postgresStoreIds, generatePostgresStoreId, postgresStoreIdTimestamp } from './storeIds';
import { STORE_IDS_METHODS } from '~/ports/storeIds';

const HEX_24 = /^[0-9a-f]{24}$/;

describe('postgresStoreIds', () => {
  it('implements every StoreIds method', () => {
    for (const method of STORE_IDS_METHODS) {
      expect(typeof postgresStoreIds[method]).toBe('function');
    }
  });

  describe('generate', () => {
    it('returns 24 lowercase hex characters', () => {
      for (let i = 0; i < 100; i++) {
        expect(postgresStoreIds.generate()).toMatch(HEX_24);
      }
    });

    it('lays the id out as ObjectId does: seconds, per-process random, counter', () => {
      const now = Date.UTC(2026, 10, 16, 12, 0, 0);
      const first = generatePostgresStoreId(now);
      const second = generatePostgresStoreId(now);
      expect(first.slice(0, 8)).toBe(
        Math.floor(now / 1000)
          .toString(16)
          .padStart(8, '0'),
      );
      expect(postgresStoreIdTimestamp(first).getTime()).toBe(now);
      /** The 5 random bytes are fixed for the process. */
      expect(second.slice(8, 18)).toBe(first.slice(8, 18));
      /** The counter goes up by one (mod 2^24). */
      const counterOf = (id: string) => parseInt(id.slice(18), 16);
      expect(counterOf(second)).toBe((counterOf(first) + 1) % 0x1000000);
    });

    it('generates ids that sort oldest first in code point order', () => {
      const base = Date.UTC(2026, 0, 1);
      const ids = [
        generatePostgresStoreId(base),
        generatePostgresStoreId(base),
        generatePostgresStoreId(base + 1000),
        generatePostgresStoreId(base + 60_000),
        generatePostgresStoreId(base + 86_400_000),
      ];
      /** `sort()` compares UTF-16 code units: code point order for hex, as `COLLATE "C"`. */
      const sorted = [...ids].sort();
      expect(sorted).toEqual(ids);
    });

    it('generates distinct ids', () => {
      const ids = new Set(Array.from({ length: 10_000 }, () => postgresStoreIds.generate()));
      expect(ids.size).toBe(10_000);
    });

    it('is a valid MongoDB ObjectId too (same format on both backends)', () => {
      const id = postgresStoreIds.generate();
      expect(Types.ObjectId.isValid(id)).toBe(true);
      expect(new Types.ObjectId(id).toString()).toBe(id);
    });
  });

  describe('isValid', () => {
    it('accepts 24 hex characters in either case', () => {
      expect(postgresStoreIds.isValid('507f1f77bcf86cd799439011')).toBe(true);
      expect(postgresStoreIds.isValid('507F1F77BCF86CD799439011')).toBe(true);
    });

    it('accepts an id object by its toHexString', () => {
      expect(postgresStoreIds.isValid(new Types.ObjectId())).toBe(true);
      expect(postgresStoreIds.isValid({ toHexString: () => '507f1f77bcf86cd799439011' })).toBe(
        true,
      );
      expect(postgresStoreIds.isValid({ toHexString: () => 'nope' })).toBe(false);
    });

    it('refuses 12-byte buffers, which ObjectId.isValid accepts, and 12-character strings (R7)', () => {
      expect(Types.ObjectId.isValid(Buffer.alloc(12))).toBe(true);
      expect(postgresStoreIds.isValid(Buffer.alloc(12))).toBe(false);
      expect(postgresStoreIds.isValid('aaaaaaaaaaaa')).toBe(false);
    });

    it('refuses everything else', () => {
      for (const value of [
        '',
        '507f1f77bcf86cd79943901',
        '507f1f77bcf86cd7994390111',
        '507f1f77bcf86cd79943901g',
        ' 507f1f77bcf86cd799439011',
        123,
        null,
        undefined,
        {},
        [],
        Buffer.alloc(12),
      ]) {
        expect(postgresStoreIds.isValid(value)).toBe(false);
      }
    });
  });

  describe('toCanonicalString and toStoreId', () => {
    it('lowercase the hex form', () => {
      const upper = '507F1F77BCF86CD799439011';
      expect(postgresStoreIds.toCanonicalString(upper)).toBe('507f1f77bcf86cd799439011');
      expect(postgresStoreIds.toStoreId(upper)).toBe('507f1f77bcf86cd799439011');
    });

    it('give an ObjectId its hex string', () => {
      const objectId = new Types.ObjectId();
      expect(postgresStoreIds.toCanonicalString(objectId)).toBe(objectId.toHexString());
      expect(postgresStoreIds.toStoreId(objectId)).toBe(objectId.toHexString());
    });

    it('agree with the MongoDB canonical string', () => {
      const id = new Types.ObjectId().toHexString().toUpperCase();
      expect(postgresStoreIds.toCanonicalString(id)).toBe(new Types.ObjectId(id).toString());
    });

    it('throw for invalid ids', () => {
      expect(() => postgresStoreIds.toCanonicalString('aaaaaaaaaaaa')).toThrow(TypeError);
      expect(() => postgresStoreIds.toStoreId('not an id')).toThrow(TypeError);
    });
  });
});
