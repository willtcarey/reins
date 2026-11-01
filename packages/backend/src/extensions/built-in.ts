/** The built-in backend extensions, registered by every app in this order (docs/dev/server-sdk.md). This is
 * the one place that imports them. */

import type { ExtensionRegistration } from "./host.js";
import { mcp } from "./mcp/index.js";

export const BUILT_IN_EXTENSIONS: readonly ExtensionRegistration[] = [{ name: "mcp", ...mcp }];
