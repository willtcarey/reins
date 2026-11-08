import { describe, expect, test } from "bun:test";
import type { ExtensionRegistration, MessageDecorator, ReinsSdk } from "@reins/sdk";
import { testSdk } from "../helpers/reins-sdk.js";

const decorator: MessageDecorator = { decorate: () => [], onChange: () => () => {} };
const pane = { title: () => "", description: () => "", icon: { mount: () => {} }, mount: () => {} };

describe("ExtensionHost", () => {
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

    sdk.extensionHost.activate(viewer, sdk.sdkFor(viewer));
    sdk.extensionHost.activate(commands, sdk.sdkFor(commands));
    sdk.views.register("diff-file-tree", { pane });
    sdk.commands.register({ name: "app", description: "", run: () => {} });

    expect(sdk.extensionHost.list()).toEqual([
      {
        extension: viewer,
        status: "loaded",
        error: null,
        registrations: { views: ["file", "file-reference"], decorators: 1, commands: [], settingsPage: true, sidebarSections: [] },
      },
      {
        extension: commands,
        status: "loaded",
        error: null,
        registrations: { views: [], decorators: 0, commands: ["compact", "new"], settingsPage: false, sidebarSections: [] },
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

    const disposeViewer = sdk.extensionHost.activate(viewer, sdk.sdkFor(viewer));
    sdk.extensionHost.activate(other, sdk.sdkFor(other));
    removeView?.();
    expect(sdk.extensionHost.list()[0]?.registrations).toEqual({ views: [], decorators: 1, commands: [], settingsPage: false, sidebarSections: [] });

    disposeViewer();
    expect(sdk.extensionHost.list().map(({ extension }) => extension.name)).toEqual(["other"]);
  });

  test("disposing an extension removes all it registered and stops its listeners, also what its disposer forgot", () => {
    const sdk = testSdk();
    const heard: object[] = [];
    const sloppy: ExtensionRegistration = {
      name: "sloppy",
      label: "Sloppy",
      register: (reins: ReinsSdk) => {
        reins.views.register("file", { pane });
        reins.commands.register({ name: "sloppy", description: "", run: () => {} });
        reins.settings.register({ mount: () => {} });
        reins.sidebar.registerSection({ id: "sloppy", mount: () => {} });
        reins.onMessage((message) => heard.push(message));
        return () => {};
      },
    };

    const dispose = sdk.extensionHost.activate(sloppy, sdk.sdkFor(sloppy));
    dispose();
    sdk.client.fireMessage({ type: "extension", extension: "sloppy", message: { after: true } });

    expect(sdk.views.rendererFor({ view: "file" })).toBeNull();
    expect(sdk.commands.list()).toEqual([]);
    expect(sdk.settingsPages.page("sloppy")).toBeNull();
    expect(sdk.sidebar.registeredBy("sloppy")).toEqual([]);
    expect(heard).toEqual([]);
  });

  test("an extension whose register function throws is failed with its error and keeps nothing it registered; the next one still loads", () => {
    const sdk = testSdk();
    const broken: ExtensionRegistration = {
      name: "broken",
      label: "Broken",
      register: (reins: ReinsSdk) => {
        reins.views.register("file", { pane });
        throw new Error("cannot start");
      },
    };
    const working: ExtensionRegistration = { name: "working", label: "Working", register: () => () => {} };
    const originalError = console.error;
    console.error = () => {};

    try {
      sdk.extensionHost.activate(broken, sdk.sdkFor(broken));
      sdk.extensionHost.activate(working, sdk.sdkFor(working));
    } finally {
      console.error = originalError;
    }

    expect(sdk.extensionHost.list().map(({ extension, status, error }) => ({ name: extension.name, status, error }))).toEqual([
      { name: "broken", status: "failed", error: "cannot start" },
      { name: "working", status: "loaded", error: null },
    ]);
    expect(sdk.views.rendererFor({ view: "file" })).toBeNull();
  });
});
