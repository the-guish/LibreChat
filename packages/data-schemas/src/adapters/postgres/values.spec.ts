import { Types, mongo } from 'mongoose';
import {
  replaceNul,
  toIdColumn,
  isIdValue,
  toTextColumn,
  toTaggedJson,
  toByteaColumn,
  fromByteaColumn,
  encodeJsonColumn,
  decodeJsonColumn,
  toTimestampColumn,
  fromTimestampColumn,
  getNulReplacementCount,
  resetNulReplacementCount,
  setNulReplacementObserver,
} from './values';
import { StoreQueryError } from '~/ports/query';

beforeEach(() => {
  resetNulReplacementCount();
  setNulReplacementObserver(undefined);
});

describe('id columns', () => {
  it('write the 24 lowercase hex characters', () => {
    expect(toIdColumn('507F1F77BCF86CD799439011')).toBe('507f1f77bcf86cd799439011');
    const objectId = new Types.ObjectId();
    expect(toIdColumn(objectId)).toBe(objectId.toHexString());
    expect(isIdValue(objectId)).toBe(true);
  });

  it('refuse anything else with StoreQueryError', () => {
    expect(() => toIdColumn('aaaaaaaaaaaa')).toThrow(StoreQueryError);
    expect(() => toIdColumn(42)).toThrow(StoreQueryError);
    expect(isIdValue('xyz')).toBe(false);
  });
});

describe('timestamp columns', () => {
  it('keep millisecond precision', () => {
    const date = new Date('2026-11-16T12:34:56.789Z');
    const written = toTimestampColumn(date);
    expect(written.getTime()).toBe(date.getTime());
    expect(written).not.toBe(date);
    expect(fromTimestampColumn(written)?.toISOString()).toBe('2026-11-16T12:34:56.789Z');
  });

  it('parse strings and numbers as new Date does', () => {
    expect(toTimestampColumn('2026-01-02T03:04:05.006Z').getTime()).toBe(
      Date.UTC(2026, 0, 2, 3, 4, 5, 6),
    );
    expect(toTimestampColumn(0).getTime()).toBe(0);
  });

  it('refuse invalid dates and dates before 4713 BC', () => {
    expect(() => toTimestampColumn(new Date('nope'))).toThrow(StoreQueryError);
    expect(() => toTimestampColumn({})).toThrow(StoreQueryError);
    expect(() => toTimestampColumn(new Date(-8.64e15))).toThrow(StoreQueryError);
    expect(toTimestampColumn(new Date(Date.UTC(-4712, 10, 24))).getUTCFullYear()).toBe(-4712);
  });

  it('read null as null', () => {
    expect(fromTimestampColumn(null)).toBeNull();
  });
});

describe('bytea columns', () => {
  it('write Buffers, Uint8Arrays and BSON binaries as Buffers', () => {
    const bytes = Buffer.from([0, 1, 2, 250, 255]);
    expect(toByteaColumn(bytes)).toEqual(bytes);
    expect(toByteaColumn(new Uint8Array([0, 1, 2, 250, 255]))).toEqual(bytes);
    expect(toByteaColumn(new mongo.Binary(bytes))).toEqual(bytes);
    expect(() => toByteaColumn('abc')).toThrow(StoreQueryError);
  });

  it('read Buffers and the \\x hex text form', () => {
    const bytes = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
    expect(fromByteaColumn(bytes)).toBe(bytes);
    expect(fromByteaColumn('\\xdeadbeef')).toEqual(bytes);
    expect(fromByteaColumn(null)).toBeNull();
  });
});

describe('U+0000 policy (D8)', () => {
  it('replaces U+0000 with U+FFFD in text columns and counts each string once', () => {
    expect(toTextColumn('a\u0000b\u0000c')).toBe('a\uFFFDb\uFFFDc');
    expect(toTextColumn('clean')).toBe('clean');
    expect(getNulReplacementCount()).toBe(1);
  });

  it('replaces it in strings and keys inside json, counting each', () => {
    const encoded = encodeJsonColumn({ 'k\u0000': ['v\u0000', { deep: '\u0000' }] });
    expect(JSON.parse(encoded)).toEqual({ 'k\uFFFD': ['v\uFFFD', { deep: '\uFFFD' }] });
    expect(encoded).not.toContain('\\u0000');
    expect(getNulReplacementCount()).toBe(3);
  });

  it('does not count when asked not to (measuring)', () => {
    expect(replaceNul('\u0000', { countNul: false })).toBe('\uFFFD');
    expect(getNulReplacementCount()).toBe(0);
  });

  it('tells the observer (the metric) about each replacement', () => {
    const observer = jest.fn();
    setNulReplacementObserver(observer);
    toTextColumn('\u0000');
    toTextColumn('\u0000\u0000');
    expect(observer).toHaveBeenCalledTimes(2);
  });
});

describe('tagged json codec', () => {
  const roundTrip = (value: unknown) => decodeJsonColumn(encodeJsonColumn(value));

  it('round-trips plain JSON values with key order kept', () => {
    const value = { z: 1, a: [true, null, 'x', 1.5, -2], m: { y: {}, b: [] } };
    const decoded = roundTrip(value) as Record<string, unknown>;
    expect(decoded).toEqual(value);
    expect(Object.keys(decoded)).toEqual(['z', 'a', 'm']);
    expect(Object.keys(decoded.m as object)).toEqual(['y', 'b']);
  });

  it('tags dates with millisecond precision and reads them back as Dates', () => {
    const date = new Date('2026-11-16T01:02:03.004Z');
    expect(encodeJsonColumn({ at: date })).toBe('{"at":{"$date":"2026-11-16T01:02:03.004Z"}}');
    const decoded = roundTrip({ at: date, list: [date] }) as { at: Date; list: Date[] };
    expect(decoded.at).toBeInstanceOf(Date);
    expect(decoded.at.getTime()).toBe(date.getTime());
    expect(decoded.list[0].getTime()).toBe(date.getTime());
  });

  it('tags binary data and reads it back as Buffers', () => {
    const bytes = Buffer.from([0, 1, 2, 3, 254, 255]);
    expect(encodeJsonColumn(bytes)).toBe(`{"$binary":"${bytes.toString('base64')}"}`);
    expect(roundTrip({ b: bytes })).toEqual({ b: bytes });
    expect(roundTrip({ b: new mongo.Binary(bytes) })).toEqual({ b: bytes });
    expect(roundTrip(new Uint8Array([7, 8]))).toEqual(Buffer.from([7, 8]));
  });

  it('writes ids as lowercase hex strings', () => {
    const objectId = new Types.ObjectId();
    expect(roundTrip({ ref: objectId, refs: [objectId] })).toEqual({
      ref: objectId.toHexString(),
      refs: [objectId.toHexString()],
    });
  });

  it('round-trips nested tagged values', () => {
    const date = new Date(Date.UTC(2020, 1, 29, 23, 59, 59, 999));
    const value = {
      events: [
        { at: date, payload: { raw: Buffer.from('hi'), seen: [date, { when: date }] } },
        { at: null },
      ],
    };
    expect(roundTrip(value)).toEqual(value);
  });

  it('drops undefined and functions from objects, and writes them as null in arrays', () => {
    expect(roundTrip({ a: undefined, f: () => 1, b: 1 })).toEqual({ b: 1 });
    expect(roundTrip([undefined, 1])).toEqual([null, 1]);
    expect(encodeJsonColumn(undefined)).toBe('null');
  });

  it('does not consult toJSON (a Date is tagged, not stringified)', () => {
    const date = new Date(0);
    expect(toTaggedJson(date)).toEqual({ $date: '1970-01-01T00:00:00.000Z' });
  });

  it('refuses keys starting with $ (a stored object can never look like a tag)', () => {
    expect(() => encodeJsonColumn({ $date: '2020-01-01T00:00:00.000Z' })).toThrow(StoreQueryError);
    expect(() => encodeJsonColumn({ ok: [{ $set: 1 }] })).toThrow(StoreQueryError);
  });

  it('refuses values JSON cannot spell, rather than storing something else', () => {
    for (const value of [
      NaN,
      Infinity,
      { n: -Infinity },
      BigInt(1),
      Symbol('s'),
      /re/,
      new Map(),
      new Set(),
      new Date('nope'),
    ]) {
      expect(() => encodeJsonColumn(value)).toThrow(StoreQueryError);
    }
  });

  it('refuses circular structures', () => {
    const value: Record<string, unknown> = {};
    value.self = value;
    expect(() => encodeJsonColumn(value)).toThrow(StoreQueryError);
    /** A shared (not circular) reference is fine. */
    const shared = { x: 1 };
    expect(roundTrip({ a: shared, b: shared })).toEqual({ a: { x: 1 }, b: { x: 1 } });
  });

  it('decodes values pg already parsed, and null', () => {
    expect(decodeJsonColumn({ at: { $date: '2026-01-01T00:00:00.000Z' }, n: [1] })).toEqual({
      at: new Date('2026-01-01T00:00:00.000Z'),
      n: [1],
    });
    expect(decodeJsonColumn(null)).toBeNull();
  });
});
