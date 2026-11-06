/**
 * How a view the app has no route of its own for is put in the URL (`#/view/<name>?<parameters>`), so that the
 * host derives a page's route from its view and views never handle URLs. Each parameter is one query parameter,
 * keys in order: a string as itself, unless it would read as another value (`"412"`, `"null"`), and any other
 * value as JSON, so numbers, booleans, nulls and objects (a `source`) come back as they went.
 */

import type { View } from "@reins/sdk";

/** JSON with every object's keys in order, so a view has one URL whatever order its parameters were given in. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => (item === undefined ? "null" : canonicalJson(item))).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const fields = Object.entries(value)
      .filter(([, field]) => field !== undefined)
      .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, field]) => `${JSON.stringify(key)}:${canonicalJson(field)}`);
    return `{${fields.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function readsAsJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

function encodeValue(value: unknown): string {
  if (typeof value === "string" && !readsAsJson(value)) return value;
  return canonicalJson(value);
}

function decodeValue(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Escapes what a fragment cannot hold, keeping what reads better as itself (`:`, `/`, `,`, `@`). */
function encodePart(text: string): string {
  return encodeURIComponent(text).replace(/%(3A|2F|2C|40)/g, (escaped) => decodeURIComponent(escaped));
}

/** The view's route under `#/view/`. */
export function viewRouteHash(view: View): string {
  const query = Object.entries(view)
    .filter(([key, value]) => key !== "view" && value !== undefined)
    .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${encodePart(key)}=${encodePart(encodeValue(value))}`)
    .join("&");
  const path = `#/view/${encodePart(view.view)}`;
  return query ? `${path}?${query}` : path;
}

/** The view a `#/view/` route's parameters give: `view`, its name, and the rest as they were encoded. */
export function viewOfRouteParams(params: Readonly<Record<string, string>>): View {
  const { view, ...parameters } = params;
  return { ...Object.fromEntries(Object.entries(parameters).map(([key, value]) => [key, decodeValue(value)])), view: view ?? "" };
}
