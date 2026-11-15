import { expect, test } from "bun:test";
import type { LauncherItem } from "@reins/sdk";
import { testSdk } from "../helpers/reins-sdk.js";

const item = (id: string): LauncherItem => ({ id, icon: { mount() {} }, title: id, run() {} });
const context = { current: null, session: null };

test("launcher.items gives the extension one function: a second call replaces the first, and its disposer removes it", async () => {
  const { reins, launcher } = testSdk();
  const first = reins.launcher.items(() => [item("first")]);
  expect(launcher.registeredBy("test")).toBe(true);

  reins.launcher.items(() => [item("second")]);
  expect(launcher.providers().map(({ extension }) => extension)).toEqual(["test"]);
  const [only] = launcher.providers();
  expect((await only!.provide(context)).map(({ id }) => id)).toEqual(["second"]);

  // The replaced registration's disposer no longer reaches the one that replaced it.
  first();
  expect(launcher.registeredBy("test")).toBe(true);
});

test("keeps each extension's function in the order the extensions first gave one", () => {
  const { reins, sdkFor, launcher } = testSdk();
  const other = sdkFor({ name: "other", label: "Other" });
  reins.launcher.items(() => []);
  const disposeOther = other.launcher.items(() => []);
  reins.launcher.items(() => [item("again")]);
  expect(launcher.providers().map(({ extension }) => extension)).toEqual(["test", "other"]);

  disposeOther();
  expect(launcher.registeredBy("other")).toBe(false);
  expect(launcher.providers().map(({ extension }) => extension)).toEqual(["test"]);
});
