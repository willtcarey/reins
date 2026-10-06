/**
 * Projects for tests: a project and its first source, a checkout on the seeded node (the node ID the
 * loopback node connects as). Product code creates projects on the node its caller chose, once the node
 * confirms the checkout (`createProject` in `models/projects.ts`).
 */
import { createProject as storeCreateProject, type Project } from "../project-store.js";
import { createSource } from "../node-store.js";
import { SEEDED_NODE_ID } from "./helpers/loopback-node.js";

export function createProject(name: string, path: string, baseBranch = "main", nodeId = SEEDED_NODE_ID): Project {
  const project = storeCreateProject(name, baseBranch);
  createSource(project.id, nodeId, path);
  return project;
}
