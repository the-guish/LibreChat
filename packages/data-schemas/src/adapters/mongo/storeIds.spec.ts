import { Types } from 'mongoose';
import type { StoreIds } from '~/ports/storeIds';
import { getDataStoreBackend } from '~/adapters/backend';
import { STORE_IDS_METHODS } from '~/ports/storeIds';
import { mongoStoreIds } from './storeIds';

const HEX = '507f1f77bcf86cd799439011';

/** Inputs callers pass today (strings, ObjectIds, nullish) and the odd ones the driver accepts. */
const INPUTS: unknown[] = [
  HEX,
  HEX.toUpperCase(),
  'abcdefghijkl',
  '',
  ' ',
  `${HEX}0`,
  HEX.slice(1),
  null,
  undefined,
  0,
  123,
  new Types.ObjectId(HEX),
  { id: HEX },
  { toHexString: () => HEX },
  {},
  new Uint8Array(12),
  'user',
];

describe('mongoStoreIds', () => {
  it('lists each method once and implements them all', () => {
    const ids: StoreIds = mongoStoreIds;
    expect(new Set(STORE_IDS_METHODS).size).toBe(STORE_IDS_METHODS.length);
    expect(Object.keys(ids).sort()).toEqual([...STORE_IDS_METHODS].sort());
  });

  it('is the backend’s id format', () => {
    expect(getDataStoreBackend().ids).toBe(mongoStoreIds);
  });

  it.each(INPUTS.map((input) => [input]))('accepts %p exactly as ObjectId.isValid', (input) => {
    expect(mongoStoreIds.isValid(input)).toBe(
      Types.ObjectId.isValid(input as Parameters<typeof Types.ObjectId.isValid>[0]),
    );
  });

  it('casts and stringifies a valid id as new ObjectId(value) does', () => {
    for (const input of [HEX, HEX.toUpperCase(), new Types.ObjectId(HEX), { id: HEX }]) {
      expect(mongoStoreIds.toCanonicalString(input)).toBe(HEX);
      const id = mongoStoreIds.toStoreId(input);
      expect(id).toBeInstanceOf(Types.ObjectId);
      expect((id as Types.ObjectId).toHexString()).toBe(HEX);
    }
  });

  it('throws for an id it does not accept', () => {
    for (const input of ['', 'abcdefghijkl', null, undefined, {}]) {
      expect(() => mongoStoreIds.toCanonicalString(input)).toThrow(TypeError);
      expect(() => mongoStoreIds.toStoreId(input)).toThrow(TypeError);
    }
  });

  it('generates distinct canonical ids', () => {
    const first = mongoStoreIds.generate();
    const second = mongoStoreIds.generate();
    expect(first).toMatch(/^[a-f\d]{24}$/);
    expect(second).not.toBe(first);
    expect(mongoStoreIds.toCanonicalString(first)).toBe(first);
  });
});
