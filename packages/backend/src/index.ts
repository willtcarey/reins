/**
 * Process bootstrap. Check existing history before any schema migrations or
 * application DB initialization; unsupported legacy formats fail without changes.
 */
import { resolveDataDir } from "./db.js";
import { assertCanonicalHistoryBeforeStartup } from "./startup-history-check.js";

assertCanonicalHistoryBeforeStartup(resolveDataDir());
await import("./server-process.js");
