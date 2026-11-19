import mongoose from 'mongoose';
import { castStoredBoolean, castStoredString, FieldCastError } from './fieldCasts';

/**
 * `castStoredBoolean` and `castStoredString` against mongoose's default casts, which the
 * conversation importers called directly before: the same value for every input mongoose casts,
 * and a throw for every input it rejects.
 */

const mongooseBoolean = mongoose.Schema.Types.Boolean.cast() as (value: unknown) => unknown;
const mongooseString = mongoose.Schema.Types.String.cast() as (value: unknown) => unknown;

type Outcome = { returned: unknown } | { threw: true };

function outcome(cast: (value: unknown) => unknown, value: unknown): Outcome {
  try {
    return { returned: cast(value) };
  } catch {
    return { threw: true };
  }
}

const objectId = new mongoose.Types.ObjectId();
const nullPrototype = Object.create(null) as object;
const withOwnToString = { toString: () => 'own' };
const withStringId = { _id: 'abc', text: 'ignored' };
const withEmptyStringId = { _id: '' };
const withObjectIdId = { _id: objectId };
const withNumberId = { _id: 5 };
class Labeled {
  toString() {
    return 'labeled';
  }
}

const inputs: Array<[string, unknown]> = [
  ['undefined', undefined],
  ['null', null],
  ['true', true],
  ['false', false],
  ["'true'", 'true'],
  ["'false'", 'false'],
  ["'TRUE'", 'TRUE'],
  ["'False'", 'False'],
  ["'yes'", 'yes'],
  ["'no'", 'no'],
  ["'Yes'", 'Yes'],
  ["'NO'", 'NO'],
  ["'y'", 'y'],
  ["'n'", 'n'],
  ["'on'", 'on'],
  ["'off'", 'off'],
  ["'1'", '1'],
  ["'0'", '0'],
  ["' 1'", ' 1'],
  ["'1.0'", '1.0'],
  ["''", ''],
  ["' '", ' '],
  ["'hello'", 'hello'],
  ["'null'", 'null'],
  ["'undefined'", 'undefined'],
  ['1', 1],
  ['0', 0],
  ['-0', -0],
  ['2', 2],
  ['-1', -1],
  ['1.5', 1.5],
  ['NaN', NaN],
  ['Infinity', Infinity],
  ['1n', BigInt(1)],
  ['0n', BigInt(0)],
  ['symbol', Symbol('s')],
  ['Date', new Date(0)],
  ['RegExp', /a/g],
  ['ObjectId', objectId],
  ['Boolean object', Object(true)],
  ['Number object', Object(1)],
  ['String object', Object('true')],
  ['[]', []],
  ['[true]', [true]],
  ["['a']", ['a']],
  ['{}', {}],
  ['null-prototype object', nullPrototype],
  ['own toString', withOwnToString],
  ['class toString', new Labeled()],
  ['string _id', withStringId],
  ["'' _id", withEmptyStringId],
  ['ObjectId _id', withObjectIdId],
  ['number _id', withNumberId],
  ['function', () => 'f'],
  ['Error', new Error('boom')],
  ['Buffer', Buffer.from('hi')],
  ['Map', new Map([['a', 1]])],
  ['Set', new Set([1])],
];

describe('castStoredBoolean', () => {
  it.each(inputs)('agrees with mongoose for %s', (_label, value) => {
    expect(outcome(castStoredBoolean, value)).toStrictEqual(outcome(mongooseBoolean, value));
  });

  it('throws a FieldCastError where mongoose rejects', () => {
    expect(() => castStoredBoolean('maybe')).toThrow(FieldCastError);
    expect(() => castStoredBoolean({})).toThrow(TypeError);
  });

  it('accepts exactly the values mongoose converts', () => {
    expect([...mongoose.Schema.Types.Boolean.convertToTrue].map(castStoredBoolean)).toEqual(
      [...mongoose.Schema.Types.Boolean.convertToTrue].map(() => true),
    );
    expect([...mongoose.Schema.Types.Boolean.convertToFalse].map(castStoredBoolean)).toEqual(
      [...mongoose.Schema.Types.Boolean.convertToFalse].map(() => false),
    );
  });
});

describe('castStoredString', () => {
  it.each(inputs)('agrees with mongoose for %s', (_label, value) => {
    expect(outcome(castStoredString, value)).toStrictEqual(outcome(mongooseString, value));
  });

  it('throws a FieldCastError where mongoose rejects', () => {
    expect(() => castStoredString({})).toThrow(FieldCastError);
    expect(() => castStoredString(['a'])).toThrow(TypeError);
  });
});
