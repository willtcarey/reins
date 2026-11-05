/** The core's SDK namespaces that scripts call, in the order `search` lists them (docs/dev/server-sdk.md). */

import { IMAGES } from "./images.js";
import { MODELS } from "./models.js";
import { NODES } from "./nodes.js";
import { PROJECTS, TASKS } from "./projects.js";
import { REVIEWS } from "./reviews.js";
import { SESSIONS } from "./sessions.js";
import { TOOLS } from "./tools.js";
import { UI } from "./ui.js";
import type { SdkNamespace } from "./declaration.js";

export const CORE_NAMESPACES: readonly SdkNamespace[] = [TASKS, SESSIONS, PROJECTS, UI, MODELS, REVIEWS, NODES, TOOLS, IMAGES];
