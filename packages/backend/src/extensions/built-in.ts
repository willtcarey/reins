/** The built-in backend extensions, registered by every app in this order (docs/dev/server-sdk.md) unless the
 * user turned one off. This is the one place that imports them; each name must be in `built-in-names.ts`. */

import type { BuiltInBackendPart } from "../extension-system/extensions.js";
import type { BuiltInExtensionName } from "./built-in-names.js";
import { mcp } from "./mcp/index.js";
import { automations } from "./automations/index.js";
import { recentSessionsExtension } from "./recent-sessions/index.js";
import { openaiImages } from "./openai-images/index.js";
import { secrets } from "./secrets/index.js";

export const BUILT_IN_EXTENSIONS: readonly (BuiltInBackendPart & { name: BuiltInExtensionName })[] = [
  { name: "mcp", ...mcp },
  { name: "automations", ...automations },
  { name: "recent-sessions", ...recentSessionsExtension },
  { name: "openai-images", ...openaiImages },
  { name: "secrets", ...secrets },
];
