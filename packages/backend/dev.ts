/**
 * Dev launcher for the backend.
 *
 * Simply runs index.ts with REINS_DEV=1 to enable in-process hot
 * reloading of handler code. No child process management needed —
 * the server watches its own src/ directory and swaps handlers
 * without restarting.
 */

process.env.REINS_DEV = "1";
await import("./src/index.js");
