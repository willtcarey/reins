/**
 * A repository's `.mcp.json` (the `mcpServers` shape of Claude Code and Cursor), as Reins reads it
 * (docs/dev/mcp-servers.md *Repo servers*): its HTTP and stdio entries, the entries it skips and why, `${VAR}`
 * expansion, and what turning a stdio entry on allows (its version: command, args, cwd and env names, and their
 * hash). Pure: reading the file, keeping what it says and allowing commands are `repo-servers.ts`' and
 * `repo-gate.ts`'.
 */

import { createHash } from "node:crypto";
import { posix } from "node:path";
import { MCP_SERVER_NAME_PATTERN } from "./input.js";

export const REPO_CONFIG_FILE = ".mcp.json";

export interface RepoHttpEntry {
  kind: "http";
  name: string;
  transport: "http" | "sse";
  url: string;
  /** As written: values may hold `${VAR}`, expanded when Reins connects. */
  headers: Record<string, string>;
}

export interface RepoStdioEntry {
  kind: "stdio";
  name: string;
  command: string;
  args: string[];
  /** As written: null for the checkout, relative inside it. */
  cwd: string | null;
  /** As written: values may hold `${VAR}`, expanded when the process starts. */
  env: Record<string, string>;
}

export type RepoEntry = RepoHttpEntry | RepoStdioEntry;

export interface RepoSkipped { name: string; reason: string }

/** What a checkout's file says: none, not readable as the `mcpServers` shape (why), or its entries. */
export type RepoFile =
  | { state: "missing" }
  | { state: "invalid"; error: string }
  | { state: "read"; entries: RepoEntry[]; skipped: RepoSkipped[] };

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const VARIABLE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isStringRecord = (value: unknown): value is Record<string, string> => isObject(value) && Object.values(value).every(item => typeof item === "string");

/** The file's text (null: there is none) as Reins takes it. A file that is not JSON, or not an object with an
 * `mcpServers` object, is `invalid`; an entry Reins cannot take is skipped with the reason, and the others are read. */
export function parseRepoConfig(text: string | null): RepoFile {
  if (text === null) return { state: "missing" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { state: "invalid", error: `Not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!isObject(parsed) || !isObject(parsed.mcpServers)) return { state: "invalid", error: "It has no \"mcpServers\" object" };
  const entries: RepoEntry[] = [];
  const skipped: RepoSkipped[] = [];
  for (const [name, value] of Object.entries(parsed.mcpServers)) {
    const entry = parseEntry(name, value);
    if ("reason" in entry) skipped.push(entry);
    else entries.push(entry);
  }
  return { state: "read", entries: entries.toSorted((a, b) => a.name.localeCompare(b.name)), skipped };
}

function parseEntry(name: string, value: unknown): RepoEntry | RepoSkipped {
  const skip = (reason: string): RepoSkipped => ({ name, reason });
  if (!MCP_SERVER_NAME_PATTERN.test(name)) {
    return skip("Its name must start with a lowercase letter and have only lowercase letters, digits and hyphens (at most 32): it names its tools");
  }
  if (!isObject(value)) return skip("It is not an object");
  const type = value.type;
  if (type !== undefined && type !== "stdio" && type !== "http" && type !== "sse") return skip(`Unknown type ${JSON.stringify(type)} (stdio, http or sse)`);
  const hasCommand = value.command !== undefined;
  const hasUrl = value.url !== undefined;
  if (type === undefined && hasCommand && hasUrl) return skip("It has both a command and a url: give its type");
  if (type === "http" || type === "sse" || (type === undefined && hasUrl)) return parseHttp(name, type === "sse" ? "sse" : "http", value, skip);
  if (type === "stdio" || hasCommand) return parseStdio(name, value, skip);
  return skip("It has neither a command nor a url");
}

function parseHttp(name: string, transport: "http" | "sse", value: Record<string, unknown>, skip: (reason: string) => RepoSkipped): RepoHttpEntry | RepoSkipped {
  if (typeof value.url !== "string" || !URL.canParse(value.url)) return skip("Its url is not a URL");
  const url = new URL(value.url);
  if (url.protocol !== "https:" && url.protocol !== "http:") return skip("Its url must be http or https");
  const headers = value.headers ?? {};
  if (!isStringRecord(headers)) return skip("Its headers must be an object of strings");
  const badHeader = Object.keys(headers).find(header => !HEADER_NAME.test(header));
  if (badHeader !== undefined) return skip(`${JSON.stringify(badHeader)} is not a header name`);
  return { kind: "http", name, transport, url: value.url, headers };
}

function parseStdio(name: string, value: Record<string, unknown>, skip: (reason: string) => RepoSkipped): RepoStdioEntry | RepoSkipped {
  if (typeof value.command !== "string" || !value.command.trim()) return skip("Its command must be a string");
  const args = value.args ?? [];
  if (!Array.isArray(args) || !args.every(arg => typeof arg === "string")) return skip("Its args must be an array of strings");
  const env = value.env ?? {};
  if (!isStringRecord(env)) return skip("Its env must be an object of strings");
  const badName = Object.keys(env).find(variable => !ENV_NAME.test(variable));
  if (badName !== undefined) return skip(`${JSON.stringify(badName)} is not an environment variable's name`);
  if (value.cwd !== undefined && value.cwd !== null && typeof value.cwd !== "string") return skip("Its cwd must be a string");
  const cwd = typeof value.cwd === "string" && value.cwd.trim() ? value.cwd.trim() : null;
  if (cwd !== null && !insideCheckout(cwd)) return skip("Its cwd must be a directory inside the checkout");
  return { kind: "stdio", name, command: value.command.trim(), args, cwd, env };
}

/** A relative path that stays inside the directory it is relative to. */
function insideCheckout(path: string): boolean {
  if (path.startsWith("/") || path.startsWith("~")) return false;
  const normalized = posix.normalize(path);
  return normalized !== ".." && !normalized.startsWith("../");
}

/** `template` with each `${VAR}` and `${VAR:-default}` replaced by `lookup(VAR)`, else its default; the variables
 * that have neither are `missing` (and expand to nothing). */
export function expandTemplate(template: string, lookup: (variable: string) => string | undefined): { value: string; missing: string[] } {
  const missing: string[] = [];
  const value = template.replace(VARIABLE, (_match, variable: string, fallback: string | undefined) => {
    const found = lookup(variable);
    if (found !== undefined && !(fallback !== undefined && found === "")) return found;
    if (fallback !== undefined) return fallback;
    missing.push(variable);
    return "";
  });
  return { value, missing };
}

/** The variables an entry's header or env values name, in order. */
export function templateVariables(entry: RepoEntry): string[] {
  const values = entry.kind === "http" ? Object.values(entry.headers) : Object.values(entry.env);
  return [...new Set(values.flatMap(value => [...value.matchAll(VARIABLE)].map(match => match[1]!)))];
}

/** What turning a stdio entry on allows: its command, args, cwd and env names. Its env values are not in it: they
 * may hold a person's own secrets, expanded from `${VAR}`. */
export interface StdioVersion { command: string; args: string[]; cwd: string | null; envNames: string[] }

export function stdioVersion(entry: RepoStdioEntry): StdioVersion {
  return { command: entry.command, args: entry.args, cwd: entry.cwd, envNames: Object.keys(entry.env).toSorted() };
}

/** The version's hash: what a project's allowed commands are keyed by. */
export function versionHash(version: StdioVersion): string {
  return createHash("sha256").update(JSON.stringify([version.command, version.args, version.cwd, version.envNames])).digest("hex");
}
