/**
 * How a remote machine gets the node: what the `/nodes/*` routes answer (routes/node-delivery.ts), outside
 * `/api` and never the web app. Each handler load builds the bundle once, in the background
 * (`buildNodeBundle`, server.ts), and serves the build it got:
 *
 * - `installScript`, `GET /nodes/install`: the install script (`install.sh`), filled in with the server
 *   URL the request reached (its origin as the node link derives it, `requestOrigin`), the build ID, its
 *   sha256 and the Bun version, so the script parses nothing. It holds no secrets.
 * - `manifest`, `GET /nodes/manifest`: `{buildId, sha256, bunVersion, size}` (`NodeBundleManifest`).
 * - `bundle`, `GET /nodes/builds/<buildId>/reins.js`: the bundle, for the current build ID only.
 *
 * The manifest, the bundle download and the install script's arguments are bootstrap surface: nodes of
 * older releases read them, so they change only additively. While the build runs, requests wait for it; a
 * failed build is logged once and the manifest and bundle answer 503. `/nodes/install` always answers a
 * script, since `curl -fsSL … | sh` hides an HTTP error from sh: without a build (failed, or not done within
 * `installWaitMs`) it is one that prints why and exits 1. The node hub asks `build()` which build a node
 * should run (ADR-025). See docs/dev/node-bundle.md.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { logger } from "../logger.js";
import { requestOrigin } from "../nodes/node-link.js";
import type { NodeBundle } from "./build.js";

export interface NodeBundleManifest {
  buildId: string;
  /** Of the bundle's bytes, in hex. */
  sha256: string;
  /** The Bun release the bundle runs on: the server's own. */
  bunVersion: string;
  /** In bytes. */
  size: number;
}

export interface NodeBundleDelivery {
  /** The install script for the server `request` reached; without a build, one that says so and fails. */
  installScript(request: Request): Promise<Response>;
  manifest(): Promise<Response>;
  /** The bundle's bytes if `buildId` is the current build's, else 404. */
  bundle(buildId: string): Promise<Response>;
  /** The build this load serves, once built; null when its build failed; `"building"` when it has not
   * finished within `waitMs` (unbounded by default). */
  build(waitMs?: number): Promise<NodeBundleManifest | null | "building">;
}

/** How long `/nodes/install` waits for a build in progress before answering a script that says so. */
export const INSTALL_BUILD_WAIT_MS = 30_000;

const INSTALL_SCRIPT = join(import.meta.dir, "install.sh");

/** Serves `bundle` (a build in progress, or one that failed) for Bun `bunVersion`. */
export function serveNodeBundle(bundle: Promise<NodeBundle>, { bunVersion, installWaitMs = INSTALL_BUILD_WAIT_MS }: { bunVersion: string; installWaitMs?: number }): NodeBundleDelivery {
  const served = bundle.then(
    ({ bytes, buildId }) => {
      const manifest: NodeBundleManifest = { buildId, sha256: createHash("sha256").update(bytes).digest("hex"), bunVersion, size: bytes.byteLength };
      logger.info(`Node bundle ${buildId.slice(0, 12)} built (${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB)`);
      return { bytes, manifest };
    },
    (error: unknown) => {
      logger.error("Node bundle build failed; nodes cannot be installed or updated until the server reloads:", error);
      return null;
    },
  );
  let script: Promise<string> | undefined;

  return {
    async build(waitMs = Infinity) {
      const ready = await within(served, waitMs);
      return ready === TIMED_OUT ? "building" : ready?.manifest ?? null;
    },
    async installScript(request) {
      const ready = await within(served, installWaitMs);
      if (ready === TIMED_OUT) return text(failingScript("the server is still building the node; try again in a minute"), 200);
      if (!ready) return text(failingScript("the server could not build the node; see its log"), 200);
      const origin = requestOrigin(request);
      if (!origin) return text("No usable Host header", 400);
      script ??= Bun.file(INSTALL_SCRIPT).text();
      const { manifest } = ready;
      return text(fillIn(await script, { SERVER_URL: origin, BUILD_ID: manifest.buildId, SHA256: manifest.sha256, BUN_VERSION: manifest.bunVersion }), 200);
    },
    async manifest() {
      const ready = await served;
      if (!ready) return unbuilt();
      return Response.json(ready.manifest, { headers: { "Cache-Control": "no-store" } });
    },
    async bundle(buildId) {
      const ready = await served;
      if (!ready) return unbuilt();
      if (buildId !== ready.manifest.buildId) return text("No such build", 404);
      return new Response(ready.bytes, { headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "public, max-age=31536000, immutable" } });
    },
  };
}

const TIMED_OUT = Symbol("timed out");

/** `promise`'s value, or `TIMED_OUT` if it has not settled within `ms`. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  if (ms === Infinity) return promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<typeof TIMED_OUT>(resolve => { timer = setTimeout(resolve, ms, TIMED_OUT); })]);
  } finally {
    clearTimeout(timer);
  }
}

/** An install script that only prints `reason` the way install.sh reports a failure, and exits 1. */
function failingScript(reason: string): string {
  return `#!/bin/sh\necho 'Reins node install failed: ${reason.replaceAll("'", "'\\''")}' >&2\nexit 1\n`;
}

function unbuilt(): Response {
  return text("The node bundle failed to build; see the server log", 503);
}

function text(body: string, status: number, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...headers } });
}

/** The script with each `@NAME@` replaced by its value, quoted for sh. */
function fillIn(script: string, values: Record<string, string>): string {
  return script.replace(/@([A-Z0-9_]+)@/g, (placeholder, name: string) => {
    const value = values[name];
    return value === undefined ? placeholder : `'${value.replaceAll("'", "'\\''")}'`;
  });
}
