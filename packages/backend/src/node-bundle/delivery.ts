/**
 * How a remote machine gets the node: `/nodes/*` on the server's HTTP server, outside `/api` (no route of
 * the router, never the web app). Each handler load builds the bundle once, in the background
 * (`buildNodeBundle`, server.ts), and serves the build it got:
 *
 * - `GET /nodes/install`: the install script (`install.sh`), filled in with the server URL the request
 *   reached (its origin as the node link derives it, `requestOrigin`), the build ID, its sha256 and the
 *   Bun version, so the script parses nothing. It holds no secrets.
 * - `GET /nodes/manifest`: `{buildId, sha256, bunVersion, size}` (`NodeBundleManifest`).
 * - `GET /nodes/builds/<buildId>/reins.js`: the bundle, for the current build ID only.
 *
 * The manifest, the bundle download and the install script's arguments are bootstrap surface: nodes of
 * older releases read them, so they change only additively. While the build runs, requests wait for it; a
 * failed build is logged once and every route answers 503. See docs/dev/node-bundle.md.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { logger } from "../logger.js";
import { requestOrigin } from "../nodes/node-link.js";
import type { NodeBundle } from "./build.js";

export const NODE_BUNDLE_PATH_PREFIX = "/nodes/";

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
  /** Answers a request under `/nodes/`; undefined for any other path. */
  handle(request: Request): Promise<Response | undefined>;
}

const INSTALL_SCRIPT = join(import.meta.dir, "install.sh");
const BUILD_PATH = /^\/nodes\/builds\/([^/]+)\/reins\.js$/;

/** Serves `bundle` (a build in progress, or one that failed) for Bun `bunVersion`. */
export function serveNodeBundle(bundle: Promise<NodeBundle>, { bunVersion }: { bunVersion: string }): NodeBundleDelivery {
  const served = bundle.then(
    ({ bytes, buildId }) => {
      const manifest: NodeBundleManifest = { buildId, sha256: createHash("sha256").update(bytes).digest("hex"), bunVersion, size: bytes.byteLength };
      logger.info(`Node bundle ${buildId.slice(0, 12)} built (${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB)`);
      return { bytes, manifest };
    },
    (error: unknown) => {
      logger.error("Node bundle build failed; /nodes/install and the bundle answer 503 until the server reloads:", error);
      return null;
    },
  );
  let script: Promise<string> | undefined;

  return {
    async handle(request) {
      const { pathname } = new URL(request.url);
      if (!pathname.startsWith(NODE_BUNDLE_PATH_PREFIX)) return undefined;
      const build = pathname.match(BUILD_PATH);
      if (pathname !== "/nodes/install" && pathname !== "/nodes/manifest" && !build) return text("Not found", 404);
      if (request.method !== "GET") return text("Method not allowed", 405, { Allow: "GET" });

      const ready = await served;
      if (!ready) return text("The node bundle failed to build; see the server log", 503);
      const { bytes, manifest } = ready;
      if (build) {
        if (build[1] !== manifest.buildId) return text("No such build", 404);
        return new Response(bytes, { headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "public, max-age=31536000, immutable" } });
      }
      if (pathname === "/nodes/manifest") return Response.json(manifest, { headers: { "Cache-Control": "no-store" } });

      const origin = requestOrigin(request);
      if (!origin) return text("No usable Host header", 400);
      script ??= Bun.file(INSTALL_SCRIPT).text();
      return text(fillIn(await script, { SERVER_URL: origin, BUILD_ID: manifest.buildId, SHA256: manifest.sha256, BUN_VERSION: manifest.bunVersion }), 200);
    },
  };
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
