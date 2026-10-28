import { describe, expect, test } from "bun:test";
import { fuzzyMatch } from "../../helpers/fuzzy-match.js";

describe("fuzzyMatch", () => {
  test("exact substring match returns 0", () => {
    const score = fuzzyMatch("hello", "hello world");
    expect(score).toBe(0);
  });

  test("exact full match returns 0", () => {
    expect(fuzzyMatch("abc", "abc")).toBe(0);
  });

  test("fuzzy match with gaps returns positive score", () => {
    const score = fuzzyMatch("hlo", "hello");
    // h(0) e l(2) l o(4) — matches h at 0, l at 2, o at 4
    expect(score).not.toBeNull();
    expect(score!).toBeGreaterThan(0);
  });

  test("case insensitive matching", () => {
    expect(fuzzyMatch("ABC", "abcdef")).toBe(0);
    expect(fuzzyMatch("abc", "ABCDEF")).toBe(0);
    expect(fuzzyMatch("HeLLo", "hello")).toBe(0);
  });

  test("no match returns null", () => {
    expect(fuzzyMatch("xyz", "hello")).toBeNull();
  });

  test("query longer than text returns null", () => {
    expect(fuzzyMatch("abcdef", "abc")).toBeNull();
  });

  test("empty query matches everything with score 0", () => {
    expect(fuzzyMatch("", "anything")).toBe(0);
    expect(fuzzyMatch("", "")).toBe(0);
  });

  test("characters out of order returns null", () => {
    expect(fuzzyMatch("ba", "abc")).toBeNull();
  });

  test("consecutive match scores lower than spread match", () => {
    const consecutive = fuzzyMatch("ab", "ab_____");
    const spread = fuzzyMatch("ab", "a____b");
    expect(consecutive).not.toBeNull();
    expect(spread).not.toBeNull();
    expect(consecutive!).toBeLessThan(spread!);
  });
});
