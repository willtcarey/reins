import { afterEach, describe, expect, test } from "bun:test";
import { SessionSidebar } from "../../components/session-sidebar.js";
import { AppStore } from "../../models/stores/app-store.js";
import { collectTemplateProperties, templateToString } from "../helpers/lit-template.js";
import { StubClient } from "../helpers/stub-client.js";

const originalWindow = globalThis.window;
const originalNavigator = globalThis.navigator;

function installViewportGlobals(options: { mobile: boolean; innerWidth: number }) {
  Reflect.set(globalThis, "navigator", { standalone: false });
  Reflect.set(globalThis, "window", {
    innerWidth: options.innerWidth,
    matchMedia: (query: string) => ({
      matches: query.includes("max-width") ? options.mobile : false,
      addEventListener() {},
      removeEventListener() {},
    }),
  });
}

afterEach(() => {
  Reflect.set(globalThis, "window", originalWindow);
  Reflect.set(globalThis, "navigator", originalNavigator);
});

function sidebar(app: AppStore) {
  const el = new SessionSidebar();
  el.app = app;
  return el;
}

describe("SessionSidebar viewport behavior", () => {
  test("uses the viewport controller mobile state instead of reading window width", () => {
    installViewportGlobals({ mobile: true, innerWidth: 1024 });

    const el = new SessionSidebar();
    Reflect.set(el, "collapsed", true);

    expect(templateToString(el.render())).toContain("class=w-full");

    Reflect.set(el, "collapsed", false);
    Reflect.get(el, "toggleCollapse").call(el);

    expect(Reflect.get(el, "collapsed")).toBe(false);
  });
});

describe("SessionSidebar: its sections", () => {
  test("mounts the sections the user has on, in their order, each under its title", () => {
    installViewportGlobals({ mobile: false, innerWidth: 1024 });
    const app = new AppStore(new StubClient(), null);
    const inbox = { id: "inbox", title: "Inbox", mount: () => {} };
    const projects = { id: "projects", title: "Projects", mount: () => {} };
    app.sidebar.register(inbox);
    app.sidebar.register({ id: "recent", title: "Recent", mount: () => {} });
    app.sidebar.register(projects);
    void app.sidebar.setVisible("recent", false);
    void app.sidebar.move("projects", -2);

    const rendered = sidebar(app).render();

    expect(collectTemplateProperties(rendered, "presentation")).toEqual([projects, inbox]);
    expect(templateToString(rendered)).toMatch(/Projects[\s\S]*Inbox/);
  });

  test("shows no section while collapsed, and badges the rail while a session runs", () => {
    installViewportGlobals({ mobile: false, innerWidth: 1024 });
    const app = new AppStore(new StubClient(), null);
    app.sidebar.register({ id: "projects", title: "Projects", mount: () => {} });
    const el = sidebar(app);
    el.collapsed = true;

    const quiet = templateToString(el.render());
    app.sessionCache.set("busy", { projectId: 1, activityState: "running" });
    const busy = templateToString(el.render());

    expect(collectTemplateProperties(el.render(), "presentation")).toEqual([]);
    expect(quiet).not.toContain("rail-badge");
    expect(busy).toContain("rail-badge");
  });
});
