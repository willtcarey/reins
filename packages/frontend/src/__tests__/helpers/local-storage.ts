/**
 * In-memory localStorage shim for bun:test.
 *
 * Import this module (side-effect only) before any code that uses
 * `localStorage`. The shim is only installed when `globalThis.localStorage`
 * is undefined, so it's safe to import unconditionally.
 */
const storage = new Map<string, string>();

if (typeof globalThis.localStorage === "undefined") {
  Object.defineProperty(globalThis, "localStorage", {
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
      clear: () => storage.clear(),
    },
    configurable: true,
  });
}
