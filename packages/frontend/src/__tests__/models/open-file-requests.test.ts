import { expect, test } from "bun:test";
import { openFilesOfShownSession } from "../../models/open-file-requests.js";
import { shownNewSession, shownSession, testSdk } from "../helpers/reins-sdk.js";

test("opens the file the server names for the session the main area shows, in the source the message names", () => {
  const { client, reins, showMain } = testSdk();
  const opened: unknown[] = [];
  const dispose = openFilesOfShownSession(client, reins.workspace, (source, file) => opened.push({ source, ...file }));
  const request = (sessionId: string, path: string) => client.fireMessage({
    type: "open_file", sessionId, projectId: 1, source: { nodeId: "box", path: "/home/will/scratch" }, path, startLine: 2, endLine: 4,
  });

  showMain(shownSession("current"));
  request("other", "ignored.ts");
  request("current", "report.html");
  showMain(shownNewSession(1));
  request("current", "ignored-too.ts");
  dispose();
  showMain(shownSession("current"));
  request("current", "after.ts");

  expect(opened).toEqual([{ source: { nodeId: "box", path: "/home/will/scratch" }, path: "report.html", startLine: 2, endLine: 4 }]);
});
