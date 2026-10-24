/** The built-in `/compact` and `/new` commands, registered through the SDK as an extension's would be. */

import type { Disposer, ReinsSdk } from "@reins/sdk";

export function registerSessionCommands(reins: ReinsSdk): Disposer {
  const disposers = [
    reins.commands.register({
      name: "compact",
      description: "Summarize the conversation so far to free its context; text after it focuses the summary",
      unavailable: ({ running }) => (running ? "The session is running; compact it once it is idle" : null),
      run: ({ sessionId, args }) => reins.sessions.compact(sessionId, args ? { instructions: args } : {}),
    }),
    reins.commands.register({
      name: "new",
      description: "Start a new session here; text after it is its first message",
      run: async ({ sessionId, args }) => {
        reins.sessions.open(await reins.sessions.createBeside(sessionId, args ? { prompt: args } : {}));
      },
    }),
  ];
  return () => { for (const dispose of disposers) dispose(); };
}
