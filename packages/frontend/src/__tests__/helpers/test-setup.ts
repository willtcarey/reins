import { afterEach } from "bun:test";
import { uninstallTestHost } from "./reins-sdk.js";

// A preload hook runs after every test of every file; one registered in a shared helper module would
// run only for the first file that imports it.
afterEach(uninstallTestHost);
