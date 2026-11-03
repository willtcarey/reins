/**
 * The automations extension's system prompt section (`reins.prompt`): so that an agent asked to watch for
 * something makes an automation, rather than waiting or polling in its turn. Only for agents that can script:
 * automations are made through `execute`.
 */

import type { PromptContribution } from "@reins/sdk/server";

const SECTION = `## Automations

When the user asks you to watch for something or to tell them later ("tell me when this deploys", "let me know when CI passes", "check this every morning"), make an automation with \`api.automations.create\` (see \`search("automations")\`), tell the user what you set up, and end your turn. Do not wait or poll in your turn: an automation wakes this session when it fires.

- Something that will happen: a command trigger, \`{ command, every }\`, which runs on the node at each interval and fires when it exits 0. Checks cost nothing until then. Leave out \`message\` and make the command print what you need to know (\`gh pr view 42 --json state -q .state | grep -x MERGED\`), or give a message saying what to do next. Use \`once: true\` when it should fire once.
- A time, or a periodic look: a schedule trigger, \`{ schedule }\` ("10m", "daily 09:00").
- A routine with a history of its own ("every morning, summarise my notifications"): \`target: "own"\`.

If you can do the work yourself with a command that ends within a few minutes (a build, a deploy script), run it instead. Cancel an automation with \`api.automations.cancel(id)\` when it is no longer needed.`;

export const automationsPromptSection: PromptContribution = ({ tools }) =>
  tools === null || tools.includes("execute") ? SECTION : null;
