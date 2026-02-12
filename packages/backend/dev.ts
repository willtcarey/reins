/**
 * Dev launcher for the Herald backend.
 *
 * Simply runs index.ts with HERALD_DEV=1 to enable in-process hot
 * reloading of handler code. No child process management needed —
 * the server watches its own src/ directory and swaps handlers
 * without restarting.
 */

process.env.HERALD_DEV = "1";
await import("./src/index.js");
