/**
 * For commands that call the Reins HTTP API (through `@reins/client`, ADR-022): which server and node
 * they mean, and what a failed request means for the exit code.
 *
 * Which server, and which node is "this node", in order: what the command line names (`--server <url>`,
 * a command's node ID argument); the node home's `node.json` (its server, and its node ID as long as the
 * server is that one), unless `--local`; the local server (`http://localhost:<REINS_PORT or 3100>`) and
 * its local node (`REINS_NODE_ID`, default `internal`). A command takes `--server` and `--local` by
 * spreading `serverOptions` into its options.
 */
import { ReinsClient, ReinsHttpError } from "@reins/client";
import { DEFAULT_LOCAL_NODE_ID } from "@reins/node/local-link";
import { nodeHome } from "@reins/node/node-home";
import { EXIT_FAILED, EXIT_UNREACHABLE, UsageError, type Env, type OptionSpecs } from "./command.js";
import { readNodeConfig } from "./node/config.js";

export const serverOptions = {
  server: { type: "string", value: "url", description: "The Reins server (default: the one this node is paired with, else the local one)" },
  local: { type: "boolean", description: "The local server and its local node, even on a paired machine" },
} satisfies OptionSpecs;

export interface ServerTarget {
  /** As `normalizeServerUrl` gives it. */
  serverUrl: string;
  /** The node the command means unless it names one. */
  nodeId: string;
  client: ReinsClient;
}

/** The server and node a command means; `nodeId` is the one it was given, if any. Throws `UsageError`
 * for a `--server` that is not an http(s) URL. */
export async function resolveServer(options: { server: string | undefined; local: boolean }, env: Env, nodeId?: string): Promise<ServerTarget> {
  const explicit = options.server === undefined ? undefined : serverUrlArgument(options.server);
  const config = options.local ? null : await readNodeConfig(nodeHome(env));
  const serverUrl = explicit ?? config?.serverUrl ?? `http://localhost:${env.REINS_PORT?.trim() || "3100"}`;
  const node = nodeId ?? (config?.serverUrl === serverUrl ? config.nodeId : env.REINS_NODE_ID?.trim() || DEFAULT_LOCAL_NODE_ID);
  return { serverUrl, nodeId: node, client: new ReinsClient({ baseUrl: serverUrl }) };
}

/** A successful answer that is not what a Reins server sends (its body does not parse), thrown by the
 * command that reads it; its message follows the server URL: "answered the pairing request with …". */
export class UnexpectedAnswer extends Error {}

export interface RequestFailure {
  message: string;
  exitCode: number;
}

/** A failed request to `serverUrl`: what to print and the exit code. A Reins error answer (JSON
 * `{error}`) is the server refusing, exit 1; any other answer (`UnexpectedAnswer` included), or none, is
 * `EXIT_UNREACHABLE`. */
export function requestFailure(error: unknown, serverUrl: string): RequestFailure {
  if (error instanceof UnexpectedAnswer) return { message: `${serverUrl} ${error.message}`, exitCode: EXIT_UNREACHABLE };
  if (error instanceof ReinsHttpError) {
    const reins = typeof error.body === "object" && error.body !== null && "error" in error.body;
    return { message: `${serverUrl} answered ${error.status}: ${error.message}`, exitCode: reins ? EXIT_FAILED : EXIT_UNREACHABLE };
  }
  return { message: `${serverUrl} did not answer: ${error instanceof Error ? error.message : String(error)}`, exitCode: EXIT_UNREACHABLE };
}

/** A server URL from the command line, normalized; a `UsageError` (not showing it) if it is not http(s). */
export function serverUrlArgument(value: string): string {
  const url = normalizeServerUrl(value);
  if (!url) throw new UsageError("The server URL must be an http:// or https:// URL.");
  return url;
}

/** A server URL as stored and compared: an http(s) URL without a trailing slash, query or fragment;
 * null if it is not one. */
export function normalizeServerUrl(value: string): string | null {
  if (!URL.canParse(value)) return null;
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}
