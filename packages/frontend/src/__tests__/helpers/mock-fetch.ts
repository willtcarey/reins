import { mock } from "bun:test";

/**
 * Replace `globalThis.fetch` with a bun mock that delegates to `handler`.
 *
 * The handler receives the resolved URL string (and optionally `init`).
 * Call `restoreFetch()` (or re-assign `originalFetch`) in `afterEach` to
 * put the real `fetch` back.
 */
export const originalFetch: typeof globalThis.fetch = globalThis.fetch;

export function mockFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): void {
  const mocked = mock((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    return Promise.resolve(handler(url, init));
  });
  // Assign via property descriptor to avoid needing a type assertion.
  // `mock()` is structurally compatible but doesn't match fetch's overloads.
  Object.defineProperty(globalThis, "fetch", { value: mocked, writable: true, configurable: true });
}

export function restoreFetch(): void {
  globalThis.fetch = originalFetch;
}
