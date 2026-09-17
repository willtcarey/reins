/**
 * Process bootstrap. No application database imports, listeners, intervals,
 * handler builds, watchers, runtime hooks, or server sockets may move above
 * this one-time history gate.
 */
import { prepareCanonicalHistoryBeforeStartup } from "./startup-history-upgrade.js";

await prepareCanonicalHistoryBeforeStartup();
await import("./server-process.js");
