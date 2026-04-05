/**
 * Request helpers for router/route tests.
 */

const TEST_BASE_URL = "http://localhost";

export function makeRequest(path: string, init?: RequestInit): Request;
export function makeRequest(method: string, path: string, body?: unknown): Request;
export function makeRequest(
  first: string,
  second?: RequestInit | string,
  third?: unknown,
): Request {
  if (typeof second === "string") {
    const init: RequestInit = { method: first };
    if (third !== undefined) {
      init.body = JSON.stringify(third);
      init.headers = { "Content-Type": "application/json" };
    }
    return new Request(`${TEST_BASE_URL}${second}`, init);
  }

  return new Request(`${TEST_BASE_URL}${first}`, second);
}

export function makeJsonRequest(method: string, path: string, body?: unknown): Request {
  return makeRequest(method, path, body);
}
