/** The built-in `/new` command, registered through the SDK as an extension's would be. */

import type { Disposer, ReinsSdk } from "@reins/sdk";

export function registerNewSessionCommand(reins: ReinsSdk): Disposer {
  return reins.commands.register({
    name: "new",
    description: "Open a new session here; text after it starts the session with that message",
    run: async ({ args }) => {
      const { workspace } = reins;
      const sessionId = workspace.currentSubject("session");
      const projectId = workspace.currentSubject("project");
      const taskId = workspace.currentSubject("task");
      if (!args) {
        workspace.open({ view: "new-session", projectId, taskId }, { in: "main" });
        return;
      }
      // Beside a session, the new one also shares its source, which the subject does not carry.
      const session = sessionId ? await reins.sessions.get(sessionId) : null;
      const place = session
        ? { projectId: session.projectId, taskId: session.taskId, source: session.source }
        : projectId == null ? null : { projectId, taskId };
      if (!place) throw new Error("Choose a project to start a session in");
      const created = await reins.sessions.create({ ...place, prompt: args });
      workspace.open({ view: "session", sessionId: created }, { in: "main" });
    },
  });
}
