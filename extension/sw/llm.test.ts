import { describe, it, expect } from 'vitest';
import { extractJson } from './llm';

describe('extractJson', () => {
  it('parses plain JSON with no fence', () => {
    expect(extractJson('{"a": 1}')).toEqual({ a: 1 });
  });

  it('strips a ```json fence', () => {
    expect(extractJson('```json\n{"a": 1}\n```')).toEqual({ a: 1 });
  });

  it('strips a plain ``` fence with no language tag', () => {
    expect(extractJson('```\n{"a": 1}\n```')).toEqual({ a: 1 });
  });

  it('trims surrounding whitespace before checking for a fence', () => {
    expect(extractJson('  \n{"a": 1}\n  ')).toEqual({ a: 1 });
  });

  it('throws on invalid JSON rather than returning a partial result', () => {
    expect(() => extractJson('not json at all')).toThrow();
  });

  it('parses an array as well as an object', () => {
    expect(extractJson('[1, 2, 3]')).toEqual([1, 2, 3]);
  });
});
