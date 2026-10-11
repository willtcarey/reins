/**
 * The docs a node bundle carries (docs/features, embedded at build time: embedded-docs.ts) and writes
 * beside itself, so a remote node's agents read the feature docs matching the code they run
 * (`REINS_DOCS_DIR`, docs/dev/node-bundle.md).
 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** One file of the docs: its path under the docs directory (`features/settings.md`) and its text. */
export interface EmbeddedDoc {
  path: string;
  text: string;
}

/** Writes `docs` to `<dir>/docs` unless that exists. They are written to a temporary directory beside it
 * and renamed into place, so no one sees half of them; of runs racing to unpack, one wins and the others
 * leave its docs alone. */
export async function unpackDocs(dir: string, docs: readonly EmbeddedDoc[]): Promise<void> {
  const target = join(dir, "docs");
  if (existsSync(target)) return;
  const staging = await mkdtemp(join(dir, ".docs-"));
  try {
    for (const doc of docs) {
      const path = join(staging, doc.path);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, doc.text);
    }
    await rename(staging, target);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    if (!existsSync(target)) throw error;
  }
}
