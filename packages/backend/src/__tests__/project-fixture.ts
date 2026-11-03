/**
 * Projects for tests: a project at home in a checkout on the seeded node (the node ID the loopback node
 * connects as), and other locations. Product code creates projects on the node its caller chose, once the
 * node confirms the checkout (`createProject` in `models/projects.ts`).
 */
import { createProject as storeCreateProject, type Project } from "../project-store.js";
import { upsertSource, type Source } from "../node-store.js";
import { SEEDED_NODE_ID } from "./helpers/loopback-node.js";

export function createProject(name: string, path: string, baseBranch = "main", nodeId = SEEDED_NODE_ID): Project {
  return storeCreateProject(name, baseBranch, upsertSource(nodeId, path).id);
}

/** The location `path` on node `nodeId` (the seeded node by default): where a session placed on it works. */
export function createSourceAt(path: string, nodeId = SEEDED_NODE_ID): Source {
  return upsertSource(nodeId, path);
}
