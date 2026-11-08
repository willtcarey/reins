import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import extension, { greet } from "./server.js";

/** The part of the SDK `greet` uses: a database with the extension's migrations, and broadcasts recorded. */
function fakeReins() {
  const db = new Database(":memory:");
  for (const migration of extension.migrations) migration.up(db);
  const broadcasts: object[] = [];
  return { db, broadcast: (message: object) => { broadcasts.push(message); }, broadcasts };
}

test("greeting counts each name and tells browsers", () => {
  const reins = fakeReins();

  greet(reins, "Ada");
  const second = greet(reins, "Ada");

  expect(second).toEqual({ message: "Hello, Ada!", count: 2 });
  expect(reins.broadcasts).toEqual([{ type: "greeted", name: "Ada" }, { type: "greeted", name: "Ada" }]);
});
