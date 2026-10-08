/**
 * The `reins` command (`bun run reins …` from source). Non-interactive: arguments in, one exit code out,
 * and the last line of output says what happened.
 *
 * `reins node pair <server URL> <code> [--force]`: pairs this machine's node home (`REINS_NODE_DATA_DIR`,
 * default `~/.reins`) with a server, redeeming a pairing code from its settings page (see pairing.ts).
 * The code is never printed.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { pairNode } from "./pairing.js";

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_USAGE = 2;
const EXIT_ALREADY_PAIRED = 3;
const EXIT_CODE_REFUSED = 4;
const EXIT_UNREACHABLE = 5;

const USAGE = "Usage: reins node pair <server URL> <code> [--force]";

/** Runs one command; resolves with its exit code. */
export async function runCli(args: readonly string[], env: Record<string, string | undefined> = process.env): Promise<number> {
  const flags = args.filter(arg => arg.startsWith("-"));
  const [group, command, serverUrl, code, ...extra] = args.filter(arg => !arg.startsWith("-"));
  if (group !== "node" || command !== "pair" || !serverUrl || !code || extra.length > 0 || flags.some(flag => flag !== "--force")) {
    console.error(USAGE);
    return EXIT_USAGE;
  }
  const home = env.REINS_NODE_DATA_DIR?.trim() || join(homedir(), ".reins");
  try {
    const result = await pairNode({ home, serverUrl, code, force: flags.includes("--force") });
    switch (result.status) {
      case "paired":
        console.log(`Paired with ${result.config.serverUrl} as node "${result.name}" (${result.config.nodeId}); config in ${result.configPath}.`);
        return EXIT_OK;
      case "invalid_server_url":
        console.error(USAGE);
        console.error("The server URL must be an http:// or https:// URL.");
        return EXIT_USAGE;
      case "already_paired":
        console.error(`Not paired: this node is already paired (${result.configPath}). Pass --force to replace the pairing; the code was not used.`);
        return EXIT_ALREADY_PAIRED;
      case "refused":
        console.error(`Not paired: the server refused the code: ${result.message}`);
        return EXIT_CODE_REFUSED;
      case "unreachable":
        console.error(`Not paired: ${result.message}`);
        return EXIT_UNREACHABLE;
    }
  } catch (error) {
    console.error(`Not paired: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT_FAILED;
  }
}

if (import.meta.main) process.exit(await runCli(process.argv.slice(2)));
