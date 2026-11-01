import { describe, expect, test } from "bun:test";
import type { ExtensionRegistration, MessageDecorator, ReinsSdk } from "@reins/sdk";
import { testSdk } from "../helpers/reins-sdk.js";

const decorator: MessageDecorator = { decorate: () => [], onChange: () => () => {} };
const pane = { title: () => "", description: () => "", icon: { mount: () => {} }, mount: () => {} };

describe("Extensions", () => {
  test("records each extension, loaded, with what it registered through its own SDK; the app's own registrations are no extension's", () => {
    const sdk = testSdk();
    const icon = { mount: () => {} };
    const viewer: ExtensionRegistration = {
      name: "viewer",
      label: "Viewer",
      description: "Shows files.",
      icon,
      register: (reins: ReinsSdk) => {
        reins.views.register("file", { pane });
        reins.views.register("file-reference", { inline: { mount: () => {} } });
        reins.messages.registerDecorator(decorator);
        reins.settings.register({ mount: () => {} });
        return () => {};
      },
    };
    const commands: ExtensionRegistration = {
      name: "commands",
      label: "Commands",
      register: (reins: ReinsSdk) => {
        reins.commands.register({ name: "new", description: "", run: () => {} });
        reins.commands.register({ name: "compact", description: "", run: () => {} });
        return () => {};
      },
    };

    sdk.extensions.activate(viewer, sdk.sdkFor(viewer));
    sdk.extensions.activate(commands, sdk.sdkFor(commands));
    sdk.views.register("diff-file-tree", { pane });
    sdk.commands.register({ name: "app", description: "", run: () => {} });

    expect(sdk.extensions.list()).toEqual([
      {
        extension: viewer,
        status: "loaded",
        error: null,
        registrations: { views: ["file", "file-reference"], decorators: 1, commands: [], settingsPage: true },
      },
      {
        extension: commands,
        status: "loaded",
        error: null,
        registrations: { views: [], decorators: 0, commands: ["compact", "new"], settingsPage: false },
      },
    ]);
  });

  test("a disposed registration leaves its extension's record, and a disposed extension leaves the list", () => {
    const sdk = testSdk();
    let removeView: (() => void) | undefined;
    const viewer: ExtensionRegistration = {
      name: "viewer",
      label: "Viewer",
      register: (reins: ReinsSdk) => {
        removeView = reins.views.register("file", { pane });
        const removeDecorator = reins.messages.registerDecorator(decorator);
        return () => removeDecorator();
      },
    };
    const other: ExtensionRegistration = { name: "other", label: "Other", register: () => () => {} };

    const disposeViewer = sdk.extensions.activate(viewer, sdk.sdkFor(viewer));
    sdk.extensions.activate(other, sdk.sdkFor(other));
    removeView?.();
    expect(sdk.extensions.list()[0]?.registrations).toEqual({ views: [], decorators: 1, commands: [], settingsPage: false });

    disposeViewer();
    expect(sdk.extensions.list().map(({ extension }) => extension.name)).toEqual(["other"]);
  });

  test("an extension whose register function throws is failed with its error, and the next one still loads", () => {
    const sdk = testSdk();
    const broken: ExtensionRegistration = { name: "broken", label: "Broken", register: () => { throw new Error("cannot start"); } };
    const working: ExtensionRegistration = { name: "working", label: "Working", register: () => () => {} };
    const originalError = console.error;
    console.error = () => {};

    try {
      sdk.extensions.activate(broken, sdk.sdkFor(broken));
      sdk.extensions.activate(working, sdk.sdkFor(working));
    } finally {
      console.error = originalError;
    }

    expect(sdk.extensions.list().map(({ extension, status, error }) => ({ name: extension.name, status, error }))).toEqual([
      { name: "broken", status: "failed", error: "cannot start" },
      { name: "working", status: "loaded", error: null },
    ]);
  });
});
