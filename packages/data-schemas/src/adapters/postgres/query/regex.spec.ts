import { prefixUpperBound, translateRegex } from './regex';
import { StoreQueryError } from '~/ports/query';

describe('translateRegex: JavaScript regular expressions to PostgreSQL ARE', () => {
  it.each([
    ['^abc$', '^abc$'],
    ['a.b', 'a[^\\n\\r\\u2028\\u2029]b'],
    [
      '\\d+\\w*\\s',
      '[0-9]+[A-Za-z0-9_]*[\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]',
    ],
    ['\\D\\W', '[^0-9][^A-Za-z0-9_]'],
    ['\\bword\\B', '\\yword\\Y'],
    ['[\\b]', '[\\u0008]'],
    ['[a-z\\d]', '[a-z0-9]'],
    ['[\\d-z]', '[0-9\\-z]'],
    ['[^\\]\\\\]', '[^\\]\\\\]'],
    ['[a[]', '[a\\[]'],
    ['\\x41B', '\\u0041B'],
    ['\\u00e9', '\\u00e9'],
    ['\\uD83D\\uDE00', '\\U0001f600'],
    ['\\a\\e\\q', 'aeq'],
    ['\\.\\/\\-', '\\./-'],
    ['a{2,3}?', 'a{2,3}?'],
    ['a{', 'a\\{'],
    ['{x}', '\\{x\\}'],
    ['a]', 'a\\]'],
    ['(?:a|b)(?=c)(?!d)', '(?:a|b)(?=c)(?!d)'],
    ['(a)\\1', '(a)\\1'],
    ['a*?b+?c??', 'a*?b+?c??'],
    ['\\cJ', '\\u000a'],
    ['😀.', '😀[^\\n\\r\\u2028\\u2029]'],
  ])('/%s/ → %s', (source, pattern) => {
    expect(translateRegex(source).pattern).toBe(pattern);
  });

  it('marks i as case-insensitive and has no prefix then', () => {
    expect(translateRegex('^ab', 'i')).toEqual({ pattern: '^ab', insensitive: true, prefix: null });
  });

  it.each([
    ['^abc', 'abc'],
    ['^a\\.b', 'a.b'],
    ['^ab?', 'a'],
    ['^ab*c', 'a'],
    ['^ab+', 'ab'],
    ['^ab{0,2}', 'a'],
    ['^ab{1,2}', 'ab'],
    ['^\\x41', 'A'],
    ['^(ab)', null],
    ['^ab|cd', null],
    ['abc', null],
    ['^[ab]', null],
    ['^\\d', null],
  ])('the literal prefix of /%s/ is %s', (source, prefix) => {
    expect(translateRegex(source).prefix).toBe(prefix);
  });

  it.each([
    ['(?<=a)b', /lookbehind/],
    ['(?<!a)b', /lookbehind/],
    ['(?<name>a)', /named groups/],
    ['\\k<name>', /by name/],
    ['\\0', /U\+0000/],
    ['[]', /no character/],
    ['[^]', /any character/],
    ['[\\D]', /inside a character class/],
    ['a{256}', /repetition/],
    ['\\uD83D', /surrogate/],
    ['(a)\\12', /past \\9/],
    ['(', /Invalid regular expression|Unterminated group/],
  ])('refuses /%s/', (source, message) => {
    expect(() => translateRegex(source)).toThrow(StoreQueryError);
    expect(() => translateRegex(source)).toThrow(message);
  });

  it('refuses flags other than i', () => {
    expect(() => translateRegex('a', 'm')).toThrow(StoreQueryError);
    expect(() => translateRegex('a', 'gi')).toThrow(StoreQueryError);
  });

  it('bounds a prefix range by the next code point', () => {
    expect(prefixUpperBound('abc')).toBe('abd');
    expect(prefixUpperBound('a\uD7FF')).toBe('a\uE000');
    expect(prefixUpperBound('a\u{10FFFF}')).toBe('b');
    expect(prefixUpperBound('\u{10FFFF}')).toBeNull();
  });
});
