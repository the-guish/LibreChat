/**
 * BSON values as the MongoDB driver hands them over, turned into the JavaScript values the
 * PostgreSQL record codec stores (docs/postgres-port/PHASE4.md §8 X1), with what had to change
 * recorded for the copy report:
 *
 * - ObjectIds are kept (the codec stores their lowercase hex, `values.ts`), dates are kept;
 * - BSON `Binary` becomes a `Buffer`;
 * - a `Long` the driver did not promote (beyond ±2^53) becomes the nearest JavaScript number and
 *   is reported with its exact decimal value: PostgreSQL's `double precision` and JSON hold no
 *   more, and the schemas declare no 64-bit integers;
 * - the other BSON types no schema declares (`Decimal128`, `Timestamp`, `Code`, `MinKey`,
 *   `MaxKey`, `DBRef`, a regular expression) become their textual or plain-object form and are
 *   reported as unsupported;
 * - strings (values and keys) holding U+0000 are counted: the codec replaces it with U+FFFD (D8).
 *
 * Values are recognized by shape (`_bsontype`), so nothing here loads the driver.
 */

/** A path pattern in a document: object keys, with `[]` for array positions. */
export type ValuePath = string;

/** What normalizing one document found. */
export interface BsonFindings {
  /** Strings (values and keys) holding U+0000. */
  nulStrings: number;
  /** `Long` values beyond ±2^53, converted to the nearest number. */
  longs: Array<{ path: ValuePath; value: string }>;
  /** Values of BSON types no schema declares, converted. */
  unsupported: Array<{ path: ValuePath; type: string }>;
}

const NUL = '\u0000';
const MAX_EXACT = 2 ** 53;

interface BsonLike {
  _bsontype?: unknown;
  toString(radix?: number): string;
  toHexString?: () => string;
  buffer?: unknown;
  position?: number;
}

function bsonType(value: object): string | undefined {
  const type = (value as BsonLike)._bsontype;
  return typeof type === 'string' ? type : undefined;
}

function childPath(path: ValuePath, key: string): ValuePath {
  return path ? `${path}.${key}` : key;
}

/** The bytes of a BSON `Binary`. */
function binaryBytes(value: BsonLike): Buffer {
  const bytes = value.buffer instanceof Uint8Array ? value.buffer : new Uint8Array();
  return Buffer.from(bytes.subarray(0, value.position ?? bytes.length));
}

/**
 * `document` with its BSON values replaced as the module header says, and what changed. The
 * input is not modified.
 */
export function normalizeBsonDocument(document: Record<string, unknown>): {
  value: Record<string, unknown>;
  findings: BsonFindings;
} {
  const findings: BsonFindings = { nulStrings: 0, longs: [], unsupported: [] };
  const convert = (value: unknown, path: ValuePath): unknown => {
    if (typeof value === 'string') {
      if (value.includes(NUL)) {
        findings.nulStrings += 1;
      }
      return value;
    }
    if (typeof value === 'bigint') {
      if (value > BigInt(MAX_EXACT) || value < -BigInt(MAX_EXACT)) {
        findings.longs.push({ path, value: value.toString() });
      }
      return Number(value);
    }
    if (value === null || typeof value !== 'object') {
      return value;
    }
    if (value instanceof Date || Buffer.isBuffer(value)) {
      return value;
    }
    if (Array.isArray(value)) {
      return value.map((item) => convert(item, `${path}[]`));
    }
    if (value instanceof RegExp) {
      findings.unsupported.push({ path, type: 'RegExp' });
      return String(value);
    }
    const type = bsonType(value);
    const bson = value as BsonLike;
    switch (type) {
      case undefined:
        break;
      case 'ObjectId':
      case 'ObjectID':
        return value;
      case 'Binary':
        return binaryBytes(bson);
      case 'Long': {
        const exact = bson.toString(10);
        const number = Number(exact);
        if (Math.abs(number) > MAX_EXACT) {
          findings.longs.push({ path, value: exact });
        }
        return number;
      }
      case 'Int32':
      case 'Double':
        return Number((value as { valueOf(): unknown }).valueOf());
      case 'Decimal128':
      case 'Code':
      case 'BSONSymbol':
      case 'Symbol':
      case 'BSONRegExp':
        findings.unsupported.push({ path, type });
        return bson.toString();
      case 'Timestamp': {
        findings.unsupported.push({ path, type });
        const timestamp = value as { t?: unknown; i?: unknown };
        return { t: Number(timestamp.t), i: Number(timestamp.i) };
      }
      case 'MinKey':
      case 'MaxKey':
        findings.unsupported.push({ path, type });
        return type;
      case 'DBRef': {
        findings.unsupported.push({ path, type });
        const ref = value as { collection?: unknown; oid?: unknown; db?: unknown };
        return {
          $ref: ref.collection,
          $id: convert(ref.oid, childPath(path, '$id')),
          ...(ref.db === undefined ? {} : { $db: ref.db }),
        };
      }
      default:
        findings.unsupported.push({ path, type });
        return bson.toString();
    }
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (key.includes(NUL)) {
        findings.nulStrings += 1;
      }
      result[key] = convert(item, childPath(path, key));
    }
    return result;
  };
  return { value: convert(document, '') as Record<string, unknown>, findings };
}

/** The id of a source document for the report: ObjectIds as hex, other values as JSON. */
export function describeSourceId(id: unknown): string {
  if (typeof id === 'string') {
    return id;
  }
  if (id !== null && typeof id === 'object') {
    const hex = (id as BsonLike).toHexString;
    if (typeof hex === 'function') {
      return hex.call(id);
    }
  }
  try {
    return JSON.stringify(id) ?? String(id);
  } catch {
    return String(id);
  }
}
