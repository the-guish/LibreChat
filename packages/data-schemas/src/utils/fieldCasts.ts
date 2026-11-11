/**
 * The casts the store applies to a value written to a boolean or string field, for code outside
 * the data layer that must predict what a record will hold (conversation imports normalize
 * untrusted fields this way before saving them). They reproduce mongoose's default casts
 * (`Schema.Types.Boolean.cast()`, `Schema.Types.String.cast()`) exactly, so every backend stores
 * the same values. Nothing here may import `mongoose`.
 */

const TRUE_VALUES: ReadonlySet<unknown> = new Set<unknown>([true, 'true', 1, '1', 'yes']);
const FALSE_VALUES: ReadonlySet<unknown> = new Set<unknown>([false, 'false', 0, '0', 'no']);

/** Thrown when a value cannot be stored in a field of the given type. */
export class FieldCastError extends TypeError {
  constructor(readonly kind: 'boolean' | 'string') {
    super(`Cast to ${kind} failed`);
    this.name = 'FieldCastError';
  }
}

/**
 * The boolean a boolean field stores for `value`: `true` for `true`, `'true'`, `1`, `'1'` and
 * `'yes'`; `false` for `false`, `'false'`, `0` (and `-0`), `'0'` and `'no'`; `null` and
 * `undefined` as given. Throws a {@link FieldCastError} for anything else.
 */
export function castStoredBoolean(value: unknown): boolean | null | undefined {
  if (TRUE_VALUES.has(value)) {
    return true;
  }
  if (FALSE_VALUES.has(value)) {
    return false;
  }
  if (value == null) {
    return value;
  }
  throw new FieldCastError('boolean');
}

/**
 * The string a string field stores for `value`: `null` and `undefined` as given; a value whose
 * `_id` is a non-empty string, that `_id`; otherwise `value.toString()` unless that is
 * `Object.prototype.toString` or `value` is an array. Throws a {@link FieldCastError} for anything
 * else (plain objects, arrays, objects without a `toString`).
 */
export function castStoredString(value: unknown): string | null | undefined {
  if (value == null) {
    return value;
  }
  const candidate = value as { _id?: unknown; toString?: unknown };
  if (candidate._id && typeof candidate._id === 'string') {
    return candidate._id;
  }
  if (
    candidate.toString &&
    candidate.toString !== Object.prototype.toString &&
    !Array.isArray(value)
  ) {
    return (value as { toString(): string }).toString();
  }
  throw new FieldCastError('string');
}
