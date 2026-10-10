/**
 * `reins node pair <server URL> <code> [--force]`: pairs this machine's node home with a server, redeeming
 * a pairing code from its settings page. The code is never printed. See docs/dev/node-contract.md
 * *Pairing and authentication*; the home's pairing is `NodeInstall`'s (install.ts).
 */
import { hostname as osHostname } from "node:os";
import { ReinsClient, ReinsHttpError, type ReinsClientOptions } from "@reins/client";
import { generateNodeKeyPair } from "@reins/node-protocol";
import { z } from "zod";
import { defineCommand, EXIT_FAILED, EXIT_OK } from "../command.js";
import { normalizeServerUrl, requestFailure, serverUrlArgument, UnexpectedAnswer, type RequestFailure } from "../server.js";
import { NodeInstall, nodeIdSchema, type Pairing } from "./install.js";
import { EXIT_REFUSED } from "./outcome.js";

export const EXIT_ALREADY_PAIRED = 3;

/** How long redeeming a code may take before the server counts as unreachable. */
const PAIR_TIMEOUT_MS = 30_000;

const pairResponseSchema = z.object({ nodeId: nodeIdSchema, name: z.string() });

export interface PairOptions {
  /** This machine's node, whose pairing it saves. */
  install: NodeInstall;
  /** An http(s) URL (the command checks it; anything else throws). Stored without a trailing slash. */
  serverUrl: string;
  code: string;
  /** Replaces an existing pairing; without it, a home with a config is refused before anything is sent. */
  force?: boolean;
  /** Sent to the server, which names the node after it when the code was made without a name. `os.hostname()` by default. */
  hostname?: string;
  /** The client's transport (`globalThis.fetch` by default). */
  fetch?: ReinsClientOptions["fetch"];
}

/** Every outcome but an unexpected failure (a filesystem error, thrown). */
export type PairResult =
  | { status: "paired"; pairing: Pairing; name: string }
  /** The home has a pairing, readable or not, and `force` was not given; nothing was sent, so the code is
   * still unused. */
  | { status: "already_paired" }
  /** The server refused the code (403: unknown, expired or used): its message. Nothing was written. */
  | { status: "refused"; message: string }
  /** Any other failed request (`requestFailure`: another Reins error answer exits 1; no answer, or not
   * as a Reins server would, 5). Nothing was written. */
  | ({ status: "request_failed" } & RequestFailure);

/** Pairs the node home with a server: generates an Ed25519 keypair in memory, redeems `code` with its
 * public key, and saves the pairing (`NodeInstall.savePairing`) only once the server has accepted it. */
export async function pairNode(options: PairOptions): Promise<PairResult> {
  const serverUrl = normalizeServerUrl(options.serverUrl);
  if (!serverUrl) throw new Error("pairNode needs an http(s) server URL");
  // A pairing that does not read is still one to keep unless replaced on purpose.
  if (!options.force && await options.install.pairing().then(pairing => pairing !== null, () => true)) return { status: "already_paired" };

  const { publicKey, privateKey } = generateNodeKeyPair();
  const client = new ReinsClient({ baseUrl: serverUrl, ...(options.fetch ? { fetch: options.fetch } : {}) });
  let paired: z.infer<typeof pairResponseSchema>;
  try {
    const response = await client.nodes.pair({
      code: options.code,
      publicKey,
      hostname: options.hostname ?? osHostname(),
    }, { signal: AbortSignal.timeout(PAIR_TIMEOUT_MS) });
    const parsed = pairResponseSchema.safeParse(response);
    if (!parsed.success) throw new UnexpectedAnswer("answered the pairing request with an unexpected body");
    paired = parsed.data;
  } catch (error) {
    if (error instanceof ReinsHttpError && error.status === 403) return { status: "refused", message: error.message };
    return { status: "request_failed", ...requestFailure(error, serverUrl) };
  }

  const pairing = await options.install.savePairing({ serverUrl, nodeId: paired.nodeId, privateKey });
  return { status: "paired", pairing, name: paired.name };
}

/** Exit 0 paired, 1 a Reins error answer or an unexpected failure, 2 usage, 3 already paired, 4 code
 * refused, 5 server unreachable or not answering as Reins (ADR-023). The home is `REINS_NODE_DATA_DIR`,
 * default `~/.reins`. */
export const nodePairCommand = defineCommand({
  words: ["node", "pair"],
  args: ["server URL", "code"],
  options: { force: { type: "boolean", description: "Replace this machine's pairing" } },
  summary: "Pair this machine's node with a Reins server, using a code from its Settings → Nodes",
  async run({ args: [serverUrl, code], options }, { env, out, err }) {
    const url = serverUrlArgument(serverUrl);
    const install = NodeInstall.of(env);
    let result: PairResult;
    try {
      result = await pairNode({ install, serverUrl: url, code, force: options.force });
    } catch (error) {
      err(`Not paired: ${error instanceof Error ? error.message : String(error)}`);
      return EXIT_FAILED;
    }
    switch (result.status) {
      case "paired":
        out(`Paired with ${result.pairing.serverUrl} as node "${result.name}" (${result.pairing.nodeId}); config in ${install.paths.pairing}.`);
        return EXIT_OK;
      case "already_paired":
        err(`Not paired: this node is already paired (${install.paths.pairing}). Pass --force to replace the pairing; the code was not used.`);
        return EXIT_ALREADY_PAIRED;
      case "refused":
        err(`Not paired: the server refused the code: ${result.message}`);
        return EXIT_REFUSED;
      case "request_failed":
        err(`Not paired: ${result.message}`);
        return result.exitCode;
    }
  },
});
