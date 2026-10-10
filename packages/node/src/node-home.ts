/**
 * The node home: `REINS_NODE_DATA_DIR`, default `~/.reins`. The node process keeps its unfinished writes
 * there (main.ts) and `reins node pair` a paired node's identity (`@reins/cli`). See
 * docs/dev/node-contract.md *Process model* and *Pairing and authentication*.
 */
import { homedir } from "node:os";
import { join } from "node:path";

export function nodeHome(env: Record<string, string | undefined> = process.env): string {
  return env.REINS_NODE_DATA_DIR?.trim() || join(homedir(), ".reins");
}
