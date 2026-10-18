/**
 * `@reins/node/testing`: a stand-in `Node` for tests that drive the server through the real node end
 * (`connectNode`). Never imported by production code.
 */
import type { Node, NodeCommands } from "../node.js";

const unscripted = (name: string) => async (): Promise<never> => { throw new Error(`Not scripted: ${name}`); };

/**
 * A `Node` whose commands are `commands`: every other command fails as a node failure ("Not scripted:
 * <name>", sent as `internal`). A script throws `NodeRejection` for a definite refusal, as a node does. It
 * pauses at once and has nothing to shut down.
 */
export function scriptedNode(commands: Partial<NodeCommands> = {}): Node {
  return {
    runProcess: unscripted("runProcess"), fileInfo: unscripted("fileInfo"), listDirectory: unscripted("listDirectory"), readFile: unscripted("readFile"),
    writeFile: unscripted("writeFile"), absolutePath: unscripted("absolutePath"), canonicalPath: unscripted("canonicalPath"), reload: unscripted("reload"),
    piExec: unscripted("piExec"), piExecAttach: unscripted("piExecAttach"), piExecKill: unscripted("piExecKill"),
    ...commands,
    pause: async () => ({ paused: true, blocking: [] }),
    shutdown: async () => {},
  };
}
