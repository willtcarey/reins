/**
 * Dev launcher for the backend.
 *
 * Simply runs index.ts with REINS_DEV=1 to enable in-process hot
 * reloading of the app. No child process management needed —
 * the server watches its own src/ directory and swaps the app
 * without restarting.
 */

process.env.REINS_DEV = "1";
await import("./src/index.js");
