/** Where this install's REINS docs are, which the node announces in its hello (`Hello.docs`): the model
 * reads them with `read`, which runs on the node. */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { NodeDocs } from "@reins/node-protocol";

/** `REINS_DOCS_DIR` (a delivered bundle's, which ships only `features/`), else the checkout's `docs/`
 * this node runs from; and whether they include the developer docs (`dev/`). */
export function reinsDocs(): NodeDocs {
  const dir = process.env.REINS_DOCS_DIR || join(dirname(fileURLToPath(import.meta.url)), "../../../docs");
  return { dir, devDocs: existsSync(join(dir, "dev")) };
}
