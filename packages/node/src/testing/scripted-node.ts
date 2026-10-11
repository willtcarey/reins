/**
 * `@reins/node/testing`: a stand-in `Node` for tests that drive the server through the real node end
 * (`connectNode`) without Pi. Never imported by production code.
 */
import type { Node, NodeCommands, NodeServer } from "../node.js";

const unscripted = (name: string) => async (): Promise<never> => { throw new Error(`Not scripted: ${name}`); };

/** A stand-in node and what was attached to it. */
export interface ScriptedNode extends Node {
  /** The server calls of the newest connection attached to it (`Node.attach`), as a real node's runtimes
   * make them; throws while none is. */
  server(): NodeServer;
}

/**
 * A `Node` whose commands are `commands`: every other command fails as a node failure ("Not scripted:
 * <name>", sent as `internal`), and `credentialsChanged` does nothing. A script throws `NodeRejection` for a
 * definite refusal, as a node does. It announces `liveSessions` in every hello (none by default), pauses at
 * once and has nothing to shut down.
 */
export function scriptedNode(commands: Partial<NodeCommands> = {}, { liveSessions = [] }: { liveSessions?: string[] } = {}): ScriptedNode {
  const attached: NodeServer[] = [];
  return {
    prompt: unscripted("prompt"), steer: unscripted("steer"), setModel: unscripted("setModel"), abort: unscripted("abort"),
    resumePending: unscripted("resumePending"), close: unscripted("close"), listSkills: unscripted("listSkills"),
    runProcess: unscripted("runProcess"), listDirectory: unscripted("listDirectory"), readFile: unscripted("readFile"),
    writeFile: unscripted("writeFile"), reload: unscripted("reload"), credentialsChanged: () => {},
    ...commands,
    pause: async () => ({ paused: true, blocking: [] }),
    shutdown: async () => {},
    liveSessions: () => liveSessions,
    attach(server) {
      attached.push(server);
      return () => { const index = attached.indexOf(server); if (index >= 0) attached.splice(index, 1); };
    },
    server() {
      const server = attached.at(-1);
      if (!server) throw new Error("No connection attached");
      return server;
    },
  };
}
