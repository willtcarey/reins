/**
 * BUNDLE ONLY: the docs the node bundle carries. The bundle build (`buildNodeBundle`,
 * packages/backend/src/node-bundle/build.ts) replaces this module with every file under docs/features, so
 * they are part of the bundle's bytes and its build ID. From source there are none, and importing it fails:
 * only the bundle's entry (entry.ts) imports it.
 */
import type { EmbeddedDoc } from "./docs.js";

export const embeddedDocs: readonly EmbeddedDoc[] = [];
throw new Error("embedded-docs.ts is filled in by the node bundle build; run the bundle, not its entry");
