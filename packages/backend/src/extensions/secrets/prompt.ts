/**
 * The secrets extension's system prompt section (`reins.prompt`): only that the feature is there, for agents that can
 * script, as requests are made through `execute`. How to use it is in `reins.secrets`' documentation, which `search` gives.
 */

import type { PromptContribution } from "@reins/sdk/server";

const SECTION = `## Secrets

To get a credential or other sensitive value from the user, use \`reins.secrets.request\` (see \`search("secrets")\`). Never ask the user to paste one into the chat.`;

export const secretsPromptSection: PromptContribution = ({ tools }) =>
  tools === null || tools.includes("execute") ? SECTION : null;
