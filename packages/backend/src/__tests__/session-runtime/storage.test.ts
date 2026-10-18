import { expect, test } from "bun:test";
import { BACKGROUND_CONTEXT, type Write } from "@earendil-works/pi-agent-core";
import { setValue, value } from "@earendil-works/pi-agent-core/harness/session";
import { getDb } from "../../app-globals.js";
import { PiStorageAdapter } from "../../pi-storage.js";
import { SessionStorage } from "../../session-runtime/storage.js";
import { createProject } from "../project-fixture.js";
import { createSession } from "../session-fixture.js";
import { useTestDb } from "../helpers/test-db.js";

useTestDb();

const marker = value<string>("test.marker");
const write = (text: string): Write => setValue(marker, text);
const textOf = (writes: Write[]) => writes[0]!.kind === "value" && writes[0]!.op === "set" ? String(writes[0]!.value) : "";

test("each commit's writes are rewritten just before it is committed, one commit at a time in order, and every failure is reported", async () => {
  createSession("s", createProject("Storage", "/tmp/storage").id, { agentRuntimeType: "pi" });
  const order: string[] = [];
  const failures: unknown[] = [];
  const firstHeld = Promise.withResolvers<void>();
  const storage = new SessionStorage(new PiStorageAdapter(getDb(), "s"), async writes => {
    const text = textOf(writes);
    order.push(text);
    if (text === "first") await firstHeld.promise;
    if (text === "broken") throw new Error("storing an image failed");
    return [write(`${text} prepared`)];
  }, error => failures.push(error));

  const first = storage.commit([write("first")], BACKGROUND_CONTEXT);
  const second = storage.commit([write("second")], BACKGROUND_CONTEXT);
  await Bun.sleep(10);
  // The second is prepared only once the first committed.
  expect(order).toEqual(["first"]);
  firstHeld.resolve();
  await Promise.all([first, second]);
  expect(order).toEqual(["first", "second"]);
  expect((await storage.getValue(marker, BACKGROUND_CONTEXT))?.value).toBe("second prepared");

  await expect(storage.commit([write("broken")], BACKGROUND_CONTEXT)).rejects.toThrow("storing an image failed");
  expect(failures).toEqual([expect.objectContaining({ message: "storing an image failed" })]);
  expect((await storage.getValue(marker, BACKGROUND_CONTEXT))?.value).toBe("second prepared");
});
