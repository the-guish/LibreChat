/**
 * JavaScript regular expressions translated to PostgreSQL's ARE dialect (docs/postgres-port/
 * PHASE4.md §2.4, R1 risk). Must not import `mongoose`, `mongodb` or `bson`.
 *
 * The query language matches `$regex` and `RegExp` values with JavaScript semantics (the
 * reference evaluator runs `RegExp#test`), flags `i` at most. The translation keeps that
 * meaning where the dialects differ:
 * - `\d`, `\w`, `\s` (and their negations) become explicit classes (`[0-9]`, `[A-Za-z0-9_]`,
 *   JavaScript's whitespace set), so neither the database locale nor the ICU collation used for
 *   `i` widens them;
 * - `.` becomes `[^\n\r\u2028\u2029]` (JavaScript's `.` stops at line terminators, ARE's does not);
 * - `\b`/`\B` become `\y`/`\Y` (`\b` is a backspace in ARE), except inside a class, where both
 *   dialects read it as a backspace;
 * - `\xHH` and `\uHHHH` become ARE's fixed-width `\uHHHH`/`\UHHHHHHHH` (ARE's `\x` takes every
 *   hex digit that follows), and a surrogate pair written as two `\u` escapes one code point;
 * - an identity escape of a letter or digit (`\a`, `\e`, ...) becomes the letter itself (ARE gives
 *   those other meanings); a `{` that is not a quantifier, and `}` and `]` outside a class, are
 *   escaped (ARE reads them as syntax).
 *
 * Refused with a `StoreQueryError`: lookbehind, named groups and backreferences by name,
 * backreferences numbered past 9, `\0` (U+0000, which stored strings never hold), `[]` and `[^]`,
 * `\D`/`\W`/`\S` inside a class, repetition counts over 255 (ARE's limit), flags other than `i`,
 * and anything else that does not parse.
 *
 * Case-insensitive matching (`i`) runs with `~*` under the `und-x-icu` collation, which folds
 * Unicode as MongoDB's PCRE does (`^élo` matches `Élodie`); case-sensitive matching runs with `~`
 * under `COLLATE "C"`. Known remaining differences: JavaScript without the `u` flag matches UTF-16
 * code units, ARE matches code points (a `.` never matches half an emoji here); PCRE's `$` also
 * matches before a final newline, JavaScript's (and ARE's) does not.
 */
import { StoreQueryError } from '~/ports/query';

/** A translated regular expression. */
export interface TranslatedRegex {
  /** The ARE pattern. */
  pattern: string;
  /** Match case-insensitively (`~*` under `und-x-icu`). */
  insensitive: boolean;
  /**
   * The literal text every match starts with, for a case-sensitive pattern anchored with `^`
   * (`^abc` → `abc`), which a btree range can serve; `null` otherwise.
   */
  prefix: string | null;
}

/** JavaScript's `\s`: the white space and line terminator characters. */
const WHITESPACE_CLASS =
  '\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff';
const DIGIT_CLASS = '0-9';
const WORD_CLASS = 'A-Za-z0-9_';
/** JavaScript's `.`: anything but a line terminator. */
const DOT = '[^\\n\\r\\u2028\\u2029]';

/** ARE's repetition limit (`RE_DUP_MAX`). */
const MAX_REPETITION = 255;

const HEX2 = /^[0-9a-fA-F]{2}$/;
const HEX4 = /^[0-9a-fA-F]{4}$/;
const QUANTIFIER_BOUND = /^\{(\d+)(,(\d*))?\}/;

function refuse(source: string, reason: string): StoreQueryError {
  return new StoreQueryError(`The regular expression /${source}/ is not supported: ${reason}`);
}

/** ARE's escape of one code point, fixed width. */
function codePointEscape(codePoint: number): string {
  return codePoint > 0xffff
    ? `\\U${codePoint.toString(16).padStart(8, '0')}`
    : `\\u${codePoint.toString(16).padStart(4, '0')}`;
}

/** A literal character, escaped when ARE would read it as syntax. */
function literalChar(char: string, inClass: boolean): string {
  if (inClass) {
    return /[\]\\^[-]/.test(char) ? `\\${char}` : char;
  }
  return /[.[\](){}*+?|^$\\]/.test(char) ? `\\${char}` : char;
}

interface EscapeResult {
  /** The ARE text. */
  text: string;
  /** Characters of the source consumed after the backslash. */
  length: number;
  /** The literal character it stands for, if it is one (for the prefix). */
  literal?: string;
  /** It is a class escape (`\d`, `\w`, `\s`). */
  classEscape?: boolean;
}

/** Translates the escape starting after the backslash at `source[index]`. */
function translateEscape(source: string, index: number, inClass: boolean): EscapeResult {
  const char = source[index];
  if (char === undefined) {
    throw refuse(source, 'it ends with a backslash');
  }
  const classOf = (body: string, negated: boolean): EscapeResult => {
    if (inClass) {
      if (negated) {
        throw refuse(source, `\\${char} inside a character class`);
      }
      return { text: body, length: 1, classEscape: true };
    }
    return { text: `[${negated ? '^' : ''}${body}]`, length: 1, classEscape: true };
  };
  switch (char) {
    case 'd':
      return classOf(DIGIT_CLASS, false);
    case 'D':
      return classOf(DIGIT_CLASS, true);
    case 'w':
      return classOf(WORD_CLASS, false);
    case 'W':
      return classOf(WORD_CLASS, true);
    case 's':
      return classOf(WHITESPACE_CLASS, false);
    case 'S':
      return classOf(WHITESPACE_CLASS, true);
    case 'b':
      return inClass ? { text: '\\u0008', length: 1, literal: '\b' } : { text: '\\y', length: 1 };
    case 'B':
      if (inClass) {
        return { text: 'B', length: 1, literal: 'B' };
      }
      return { text: '\\Y', length: 1 };
    case 't':
      return { text: '\\t', length: 1, literal: '\t' };
    case 'n':
      return { text: '\\n', length: 1, literal: '\n' };
    case 'r':
      return { text: '\\r', length: 1, literal: '\r' };
    case 'v':
      return { text: '\\v', length: 1, literal: '\v' };
    case 'f':
      return { text: '\\f', length: 1, literal: '\f' };
    case '0':
      if (/[0-9]/.test(source[index + 1] ?? '')) {
        throw refuse(source, 'octal escapes');
      }
      throw refuse(source, '\\0 matches U+0000, which stored strings never hold');
    case 'x': {
      const hex = source.slice(index + 1, index + 3);
      if (HEX2.test(hex)) {
        const codePoint = parseInt(hex, 16);
        return {
          text: codePointEscape(codePoint),
          length: 3,
          literal: String.fromCodePoint(codePoint),
        };
      }
      return { text: 'x', length: 1, literal: 'x' };
    }
    case 'u': {
      const hex = source.slice(index + 1, index + 5);
      if (!HEX4.test(hex)) {
        return { text: 'u', length: 1, literal: 'u' };
      }
      const unit = parseInt(hex, 16);
      if (unit >= 0xd800 && unit <= 0xdbff) {
        const next =
          source.slice(index + 5, index + 7) === '\\u' ? source.slice(index + 7, index + 11) : '';
        const low = HEX4.test(next) ? parseInt(next, 16) : -1;
        if (low >= 0xdc00 && low <= 0xdfff) {
          const codePoint = 0x10000 + ((unit - 0xd800) << 10) + (low - 0xdc00);
          return {
            text: codePointEscape(codePoint),
            length: 11,
            literal: String.fromCodePoint(codePoint),
          };
        }
        throw refuse(source, 'a lone surrogate escape');
      }
      if (unit >= 0xdc00 && unit <= 0xdfff) {
        throw refuse(source, 'a lone surrogate escape');
      }
      if (unit === 0) {
        throw refuse(source, '\\u0000 matches U+0000, which stored strings never hold');
      }
      return { text: codePointEscape(unit), length: 5, literal: String.fromCodePoint(unit) };
    }
    case 'c': {
      const letter = source[index + 1];
      if (letter !== undefined && /[A-Za-z]/.test(letter)) {
        const codePoint = letter.toUpperCase().charCodeAt(0) % 32;
        return {
          text: codePointEscape(codePoint),
          length: 2,
          literal: String.fromCodePoint(codePoint),
        };
      }
      throw refuse(source, '\\c without a control letter');
    }
    case 'k':
      throw refuse(source, 'backreferences by name');
    default:
      break;
  }
  if (/[1-9]/.test(char)) {
    if (inClass) {
      throw refuse(source, 'octal escapes inside a character class');
    }
    if (/[0-9]/.test(source[index + 1] ?? '')) {
      throw refuse(source, 'backreferences past \\9');
    }
    return { text: `\\${char}`, length: 1 };
  }
  const codePoint = source.codePointAt(index) as number;
  const whole = String.fromCodePoint(codePoint);
  if (/[A-Za-z0-9]/.test(whole)) {
    /** An identity escape of a letter: the letter itself (ARE gives `\a`, `\e`, ... meanings). */
    return { text: whole, length: whole.length, literal: whole };
  }
  return { text: literalChar(whole, inClass), length: whole.length, literal: whole };
}

/** Translates a character class starting at `source[start]` (`[`); returns the text and the end. */
function translateClass(source: string, start: number): { text: string; end: number } {
  let index = start + 1;
  let text = '[';
  if (source[index] === '^') {
    text += '^';
    index += 1;
  }
  if (source[index] === ']') {
    throw refuse(source, text === '[^' ? '[^] (any character)' : '[] (no character)');
  }
  let previousWasClassEscape = false;
  for (;;) {
    const char = source[index];
    if (char === undefined) {
      throw refuse(source, 'an unterminated character class');
    }
    if (char === ']') {
      return { text: `${text}]`, end: index + 1 };
    }
    if (char === '\\') {
      const escape = translateEscape(source, index + 1, true);
      text += escape.text;
      index += 1 + escape.length;
      previousWasClassEscape = escape.classEscape === true;
      continue;
    }
    if (char === '-') {
      const next = source[index + 1];
      const nextIsClassEscape = next === '\\' && /[dDwWsS]/.test(source[index + 2] ?? '');
      const literalDash =
        previousWasClassEscape ||
        next === ']' ||
        nextIsClassEscape ||
        text.endsWith('[') ||
        text.endsWith('[^');
      text += literalDash ? '\\-' : '-';
      index += 1;
      previousWasClassEscape = false;
      continue;
    }
    const codePoint = source.codePointAt(index) as number;
    const whole = String.fromCodePoint(codePoint);
    text += literalChar(whole, true);
    index += whole.length;
    previousWasClassEscape = false;
  }
}

/** Whether the pattern has a `|` outside any class (alternation at some depth). */
function hasAlternation(source: string): boolean {
  let inClass = false;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (char === '\\') {
      index += 1;
      continue;
    }
    if (inClass) {
      if (char === ']') inClass = false;
      continue;
    }
    if (char === '[') inClass = true;
    else if (char === '|') return true;
  }
  return false;
}

/**
 * The literal text a pattern anchored with `^` starts with: the characters up to the first
 * piece of syntax, without the last one when a quantifier that allows zero follows it.
 */
function literalPrefix(source: string): string | null {
  if (!source.startsWith('^') || hasAlternation(source)) {
    return null;
  }
  const chars: string[] = [];
  let index = 1;
  while (index < source.length) {
    const char = source[index];
    if (char === '\\') {
      let escape: EscapeResult;
      try {
        escape = translateEscape(source, index + 1, false);
      } catch {
        break;
      }
      if (escape.literal === undefined) break;
      chars.push(escape.literal);
      index += 1 + escape.length;
      continue;
    }
    if ('.[](){}*+?|^$'.includes(char)) {
      break;
    }
    const whole = String.fromCodePoint(source.codePointAt(index) as number);
    chars.push(whole);
    index += whole.length;
  }
  const next = source[index];
  if (next === '?' || next === '*' || (next === '{' && /^\{0[,}]/.test(source.slice(index)))) {
    chars.pop();
  }
  return chars.length > 0 ? chars.join('') : null;
}

/**
 * Translates a JavaScript regular expression (`source` and `flags`, as `RegExp` holds them) to
 * ARE. Throws a `StoreQueryError` for what has no faithful translation (see the module header).
 */
export function translateRegex(source: string, flags = ''): TranslatedRegex {
  if (flags !== '' && flags !== 'i') {
    throw new StoreQueryError(`Regular expression flags "${flags}" are not supported (only "i")`);
  }
  try {
    new RegExp(source, flags);
  } catch (error) {
    throw refuse(source, error instanceof Error ? error.message : String(error));
  }
  let pattern = '';
  /** Whether the last emitted piece can take a quantifier. */
  let quantifiable = false;
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    switch (char) {
      case '\\': {
        const escape = translateEscape(source, index + 1, false);
        pattern += escape.text;
        index += 1 + escape.length;
        quantifiable = escape.text !== '\\y' && escape.text !== '\\Y';
        continue;
      }
      case '[': {
        const translated = translateClass(source, index);
        pattern += translated.text;
        index = translated.end;
        quantifiable = true;
        continue;
      }
      case '(': {
        if (source[index + 1] === '?') {
          const kind = source.slice(index + 2, index + 4);
          if (kind.startsWith(':')) {
            pattern += '(?:';
            index += 3;
          } else if (kind.startsWith('=') || kind.startsWith('!')) {
            pattern += `(?${kind[0]}`;
            index += 3;
          } else if (kind === '<=' || kind === '<!') {
            throw refuse(source, 'lookbehind');
          } else if (kind.startsWith('<')) {
            throw refuse(source, 'named groups');
          } else {
            throw refuse(source, `the group syntax (?${kind}`);
          }
        } else {
          pattern += '(';
          index += 1;
        }
        quantifiable = false;
        continue;
      }
      case ')':
        pattern += ')';
        index += 1;
        quantifiable = true;
        continue;
      case '.':
        pattern += DOT;
        index += 1;
        quantifiable = true;
        continue;
      case '{': {
        const bound = QUANTIFIER_BOUND.exec(source.slice(index));
        if (bound && quantifiable) {
          const low = Number(bound[1]);
          const high = bound[3] ? Number(bound[3]) : low;
          if (low > MAX_REPETITION || high > MAX_REPETITION) {
            throw refuse(source, `repetition counts over ${MAX_REPETITION}`);
          }
          pattern += bound[0];
          index += bound[0].length;
          if (source[index] === '?') {
            pattern += '?';
            index += 1;
          }
          quantifiable = false;
          continue;
        }
        pattern += '\\{';
        index += 1;
        quantifiable = true;
        continue;
      }
      case '}':
      case ']':
        pattern += `\\${char}`;
        index += 1;
        quantifiable = true;
        continue;
      case '*':
      case '+':
      case '?':
        pattern += char;
        index += 1;
        /** A lazy quantifier (`*?`, `+?`, `??`). */
        if (source[index] === '?') {
          pattern += '?';
          index += 1;
        }
        quantifiable = false;
        continue;
      case '|':
      case '^':
      case '$':
        pattern += char;
        index += 1;
        quantifiable = false;
        continue;
      default: {
        const whole = String.fromCodePoint(source.codePointAt(index) as number);
        pattern += literalChar(whole, false);
        index += whole.length;
        quantifiable = true;
      }
    }
  }
  const insensitive = flags === 'i';
  return { pattern, insensitive, prefix: insensitive ? null : literalPrefix(source) };
}

/**
 * The first string after every string starting with `prefix`, in code point order: `prefix` with
 * its last code point incremented (`null` when that is not possible).
 */
export function prefixUpperBound(prefix: string): string | null {
  const points = Array.from(prefix, (char) => char.codePointAt(0) as number);
  while (points.length > 0) {
    let last = (points.pop() as number) + 1;
    if (last >= 0xd800 && last <= 0xdfff) {
      last = 0xe000;
    }
    if (last <= 0x10ffff) {
      points.push(last);
      return String.fromCodePoint(...points);
    }
  }
  return null;
}
