/**
 * Tests for last-viewed hash persistence in localStorage.
 *
 * Covers the router helpers (getLastHash, saveHash) used to restore
 * the user's last route on fresh page loads.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import "./helpers/local-storage.js";

import { getLastHash, saveHash } from "../models/router.js";

const STORAGE_KEY = "reins:last-hash";

describe("last hash persistence", () => {
  beforeEach(() => {
    localStorage.removeItem(STORAGE_KEY);
  });

  afterEach(() => {
    localStorage.removeItem(STORAGE_KEY);
  });

  test("getLastHash returns null when nothing stored", () => {
    expect(getLastHash()).toBeNull();
  });

  test("saveHash stores and getLastHash retrieves", () => {
    saveHash("#/session/abc-123");
    expect(getLastHash()).toBe("#/session/abc-123");
  });

  test("saveHash overwrites previous value", () => {
    saveHash("#/session/first");
    saveHash("#/session/second");
    expect(getLastHash()).toBe("#/session/second");
  });

  test("getLastHash returns null for empty string", () => {
    localStorage.setItem(STORAGE_KEY, "");
    expect(getLastHash()).toBeNull();
  });
});
