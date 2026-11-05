import { afterEach, describe, expect, test } from "bun:test";
import { type InputRequest, setInputHostForTesting } from "../../ui/input-dialog.js";
import { makeSessionListItem } from "../helpers/fixtures.js";
import { mockFetch, restoreFetch } from "../helpers/mock-fetch.js";
import { testSdk } from "../helpers/reins-sdk.js";

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });

afterEach(() => {
  restoreFetch();
  setInputHostForTesting(null);
});

/** Answers each question by saving `value`, and records what it was asked. */
function answering(value: string) {
  const asked: Omit<InputRequest, "save">[] = [];
  setInputHostForTesting({
    open: async ({ save, ...question }) => {
      asked.push(question);
      await save(value);
      return true;
    },
  });
  return asked;
}

describe("reins.ui.renameSession", () => {
  test("asks for the name, the first message shown for a blank one, and saves a blank name as none", async () => {
    const { reins, sessions } = testSdk();
    sessions.setMany([makeSessionListItem("work", { name: "Old name", firstMessage: "Investigate the release" })]);
    const writes: string[] = [];
    mockFetch((url, init) => {
      writes.push(`${init?.method} ${url} ${init?.body}`);
      return json(makeSessionListItem("work", { name: null }));
    });
    const asked = answering("");

    const saved = await reins.ui.renameSession("work");

    expect(saved).toBe(true);
    expect(asked).toEqual([{ heading: "Rename Session", label: "Name", value: "Old name", placeholder: "Investigate the release", hint: "Leave blank to use the first message." }]);
    expect(writes).toEqual(['PATCH /api/sessions/work/metadata {"name":null}']);
  });

  test("loads a session the app does not have before asking", async () => {
    const { reins } = testSdk();
    mockFetch((url, init) => init?.method === "PATCH"
      ? json(makeSessionListItem("elsewhere", { name: "Renamed" }))
      : json({ ...makeSessionListItem("elsewhere", { name: null, firstMessage: "Fix the build" }), background: false, pendingOperation: null, state: { model: null, thinkingLevel: "high" } }));
    const asked = answering("Renamed");

    await reins.ui.renameSession("elsewhere");

    expect(asked.map(({ value, placeholder }) => ({ value, placeholder }))).toEqual([{ value: "", placeholder: "Fix the build" }]);
  });
});
