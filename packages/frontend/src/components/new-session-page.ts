/**
 * The new session page: a project, a task, where the session works and a model to choose, and a composer.
 * Nothing is created until its first message is sent, or that message's attachments are uploaded; then the
 * page is replaced by the session's, and the message flies into the session's conversation (`SendHandoff`).
 * Where it works is the server's default for the project and task (its task's latest session's location,
 * else the project's default source) until another is chosen: one of the project's paths, or any directory on a node.
 */

import { LitElement, html, type PropertyValues } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import type { Disposer, Subject, Views } from "@reins/sdk";
import type { ModelSetting } from "@backend/settings-store.js";
import type { ProjectLocationsView } from "@backend/models/sessions.js";
import { api } from "../models/api.js";
import type { AppStore } from "../models/stores/app-store.js";
import { uploadSessionAttachments } from "../models/stores/active-session-store.js";
import type { ProjectStore } from "../models/stores/project-store.js";
import type { ProjectsStore } from "../models/stores/projects-store.js";
import { StoreController } from "../controllers/store-controller.js";
import { navigate, navigateToSession, newSessionHash } from "../routing/app-router.js";
import type { ChatComposer, DraftAttachment } from "./chat-composer.js";
import type { ChatComposerSubmitDetail } from "./events.js";
import type { LocationDialog } from "./location-dialog.js";
import { branchIcon, conversationIcon, folderIcon, navigationFolderIcon, paneIcon } from "../ui/icons.js";
import "./location-dialog.js";
import "../ui/choice-menu.js";
import "../ui/choice-selector.js";
import "./chat-composer.js";
import "./model-picker.js";

type Location = { nodeId: string; path: string };

const ANOTHER_DIRECTORY = -1;

const locationKey = (location: Location | null) => location ? `${location.nodeId}\0${location.path}` : "";

/** The new session page in the main area, with the project and task chosen in it so far. */
export type NewSessionView = { view: "new-session"; projectId: number | null; taskId: number | null };

declare module "@reins/sdk" {
  interface ViewTypes {
    "new-session": NewSessionView;
  }
}

/** What the page is about: the task and the project chosen on it. */
function subjectOf({ projectId, taskId }: NewSessionView): Subject[] {
  if (projectId == null) return [];
  return taskId == null ? [{ type: "project", id: projectId }] : [{ type: "task", id: taskId }, { type: "project", id: projectId }];
}

/**
 * Registers the new session page as the main area's `new-session` page, over the app's stores (app code, as the
 * Changes tab is). A project and task are one page, so opening it again for them is in place.
 */
export function registerNewSessionPage(views: Views, app: AppStore): Disposer {
  return views.register("new-session", {
    key: ({ projectId, taskId }) => `${projectId}:${taskId}`,
    pane: {
      title: () => "New session",
      description: () => "Start a session",
      icon: paneIcon(conversationIcon),
      mount(target, view) {
        const page = target.ownerDocument.createElement("new-session-page");
        page.setAttribute("class", "block h-full min-h-0 min-w-0");
        page.app = app;
        page.view = view;
        target.append(page);
        return {
          update: (next) => { page.view = next; },
          dispose: () => page.remove(),
          subject: () => subjectOf(page.view),
        };
      },
    },
  });
}

@customElement("new-session-page")
export class NewSessionPage extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false }) app: AppStore | null = null;
  @property({ attribute: false }) view: NewSessionView = { view: "new-session", projectId: null, taskId: null };

  @state() private defaultModel: ModelSetting | null = null;
  @state() private model: ModelSetting | null = null;
  /** Where the session can work, for the project and task shown (null until loaded, or when it failed). */
  @state() private locations: ProjectLocationsView | null = null;
  /** Where the session works when chosen here; null: the server's default. */
  @state() private location: Location | null = null;

  @query("chat-composer") private composer?: ChatComposer;
  @query("location-dialog") private locationDialog?: LocationDialog;

  /**
   * The session the page created and the model it has from the page. A send that fails after the session
   * exists is tried again in it, so the page does not leave an empty session for each try (the server
   * cannot create and prompt in one request).
   */
  private created: { projectId: number; taskId: number | null; location: string; sessionId: string; model: ModelSetting | null } | null = null;
  /** The project and task whose locations are loaded or loading. */
  private locationsFor = "";
  private projects = new StoreController<ProjectsStore>(this);
  private project = new StoreController<ProjectStore>(this);

  override connectedCallback() {
    super.connectedCallback();
    void this.loadDefaultModel();
  }

  override willUpdate(changed: PropertyValues<this>) {
    if (changed.has("app")) this.projects.store = this.app?.projectsStore ?? null;
    if (changed.has("app") || changed.has("view")) {
      const { projectId } = this.view;
      const projectsStore = this.app?.projectsStore;
      this.project.store = projectsStore && projectId != null ? projectsStore.getStore(projectId) : null;
      if (projectsStore && projectId != null) void projectsStore.ensureLoaded(projectId);
      void this.loadLocations();
    }
  }

  /** Each project's own: a location chosen for another project is dropped. */
  private async loadLocations() {
    const { projectId, taskId } = this.view;
    const key = `${projectId}:${taskId}`;
    if (key === this.locationsFor) return;
    if (!this.locationsFor.startsWith(`${projectId}:`)) this.location = null;
    this.locationsFor = key;
    this.locations = null;
    if (projectId == null) return;
    try {
      const locations = await api.projects.locations(projectId, taskId);
      if (this.locationsFor === key) this.locations = locations;
    } catch {
      // Without them the page offers only another directory, and the server places the session.
    }
  }

  /** Where the session works: the one chosen, else the server's default once known. */
  private get placement(): Location | null {
    return this.location ?? this.locations?.default ?? null;
  }

  override updated(changed: PropertyValues<this>) {
    if (changed.has("view")) this.focusComposer();
  }

  /** So the message can be typed at once; not on a touch screen, where it would open the keyboard over the page. */
  private focusComposer() {
    if ("ontouchstart" in window || navigator.maxTouchPoints > 0) return;
    this.composer?.focusInput();
  }

  private async loadDefaultModel() {
    try {
      const [setting] = await api.settings.list(["default_model"]);
      this.defaultModel = setting?.key === "default_model" ? setting.value : null;
    } catch {
      // Without it the picker shows nothing until a model is chosen; the session still gets the default.
    }
  }

  /** The page's URL holds its choices, so they last a reload and are what commands see. */
  private choose(projectId: number | null, taskId: number | null) {
    navigate(newSessionHash({ projectId, taskId }), true);
  }

  private chooseModel = (model: ModelSetting) => {
    this.model = model;
  };

  /** The session for the chosen project and task, with the chosen model: the one created before, or a new one. */
  private async session(app: AppStore): Promise<string> {
    const { projectId, taskId } = this.view;
    if (projectId == null) throw new Error("Choose a project to start a session in");
    const model = this.model;
    const created = this.created;
    const location = this.location;
    if (created?.projectId === projectId && created.taskId === taskId && created.location === locationKey(location)) {
      // The picker makes a new object for each choice, so this is a model chosen after the session was created.
      if (model && model !== created.model) {
        app.sessionCache.set(created.sessionId, await app.sessionOperations.setModel(created.sessionId, model));
        created.model = model;
      }
      return created.sessionId;
    }
    const result = await app.projectsStore.createSession(projectId, {
      ...(taskId == null ? {} : { taskId }),
      ...(location ? { source: location } : {}),
      // No runtime: creating makes a Pi session, the only runtime a session can have (`Sessions.setModel`).
      ...(model ? { model: { provider: model.provider, modelId: model.modelId, thinkingLevel: model.thinkingLevel } } : {}),
    });
    if ("error" in result) throw new Error(result.error);
    this.created = { projectId, taskId, location: locationKey(location), sessionId: result.sessionId, model };
    return result.sessionId;
  }

  private upload = async (attachments: readonly DraftAttachment[]) => {
    if (!this.app) throw new Error("The page is not ready yet");
    return uploadSessionAttachments(await this.session(this.app), attachments);
  };

  private submit = async ({ content, source }: ChatComposerSubmitDetail) => {
    const app = this.app;
    if (!app) throw new Error("The page is not ready yet");
    const sessionId = await this.session(app);
    const submission = app.sessionOperations.submit(sessionId, "prompt", content);
    if (!submission) throw new Error("The message could not be sent");
    // The conversation shows a refusal; the session's details then say it is not running.
    submission.admitted.catch(() => { void app.sessionCache.fetchDetail(sessionId); });
    if (source) app.sendHandoff.give({ sessionId, messageKey: submission.entry.localId, source });
    navigateToSession(sessionId, true);
  };

  private renderProjectChoice() {
    const { projectId } = this.view;
    const projects = this.app?.projects ?? [];
    const chosen = projects.find((project) => project.id === projectId);
    return html`
      <choice-selector
        data-role="project-choice"
        label=${chosen?.name ?? (projectId == null ? "Choose a project" : `Project ${projectId}`)}
        .icon=${folderIcon("shrink-0", 12)}
        ?prompt=${projectId == null}
        panelClass="w-64"
        .content=${() => html`
          <choice-menu
            .items=${projects.map((project) => ({ id: project.id, label: project.name }))}
            .selected=${projectId}
            .choose=${(id: number | null) => { if (id != null && id !== projectId) this.choose(id, null); }}
            placeholder="Search projects…"
            emptyMessage=${projects.length === 0 ? "No projects yet" : "No project matches"}
          ></choice-menu>
        `}
      ></choice-selector>
    `;
  }

  private renderTaskChoice() {
    const { projectId, taskId } = this.view;
    if (projectId == null) return "";
    const tasks = this.project.store?.tasks ?? [];
    const chosen = tasks.find((task) => task.id === taskId);
    return html`
      <choice-selector
        data-role="task-choice"
        label=${taskId == null ? "No task" : chosen?.title ?? `Task ${taskId}`}
        .icon=${taskId == null ? conversationIcon("shrink-0", 12) : branchIcon("shrink-0", 12)}
        panelClass="w-72"
        .content=${() => html`
          <choice-menu
            .items=${[
              { id: null, label: "No task", detail: "A conversation with the project's assistant" },
              ...tasks.map((task) => ({ id: task.id, label: task.title, detail: task.branch_name })),
            ]}
            .selected=${taskId}
            .choose=${(id: number | null) => this.choose(projectId, id)}
            placeholder="Search tasks…"
            emptyMessage="No task matches"
          ></choice-menu>
        `}
      ></choice-selector>
    `;
  }

  /** The project's paths on each node, then another directory (`LocationDialog`). */
  private renderLocationChoice() {
    if (this.view.projectId == null) return "";
    const nodes = this.locations?.nodes ?? [];
    const known = nodes.flatMap((node) => node.paths.map((path) => ({ nodeId: node.nodeId, path, node: node.connected ? node.name : `${node.name} (offline)` })));
    const placement = this.placement;
    const selected = known.findIndex((entry) => locationKey(entry) === locationKey(placement));
    const nodeName = nodes.find((node) => node.nodeId === placement?.nodeId)?.name ?? placement?.nodeId;
    const label = placement ? `${placement.path.slice(placement.path.lastIndexOf("/") + 1) || placement.path} · ${nodeName}` : "Where it works";
    return html`
      <choice-selector
        data-role="location-choice"
        label=${label}
        title=${placement ? `${placement.path} on ${nodeName}` : ""}
        .icon=${navigationFolderIcon("shrink-0", 12)}
        panelClass="w-80"
        .content=${() => html`
          <choice-menu
            data-role="location-menu"
            .items=${[
              ...known.map((entry, index) => ({ id: index, label: entry.path, detail: entry.node })),
              { id: ANOTHER_DIRECTORY, label: "Another directory…", detail: "Any directory on a node" },
            ]}
            .selected=${selected === -1 ? null : selected}
            .choose=${(id: number | null) => {
              if (id === ANOTHER_DIRECTORY) return this.chooseAnotherDirectory();
              const entry = id == null ? undefined : known[id];
              if (entry) this.location = { nodeId: entry.nodeId, path: entry.path };
            }}
            placeholder="Search paths…"
            emptyMessage="No path matches"
          ></choice-menu>
        `}
      ></choice-selector>
    `;
  }

  private chooseAnotherDirectory() {
    const nodes = this.locations?.nodes ?? [];
    const placement = this.placement;
    void this.locationDialog?.open({
      heading: "Where the session works",
      subtitle: this.app?.projects.find((project) => project.id === this.view.projectId)?.name ?? "",
      confirmLabel: "Use",
      busyLabel: "Use",
      loadTargets: async () => nodes,
      ...(placement ? { initial: placement } : {}),
      // Checked on its node when the session is created there.
      choose: async (nodeId, path) => {
        this.location = { nodeId, path };
        return { ok: true as const };
      },
    });
  }

  override render() {
    return html`
      <div class="flex h-full flex-col overflow-y-auto px-4 pb-[var(--input-bottom)]">
        <div class="m-auto w-full max-w-2xl py-8">
          <h1 class="mb-6 text-center text-2xl font-medium text-zinc-200">What do you want to work on?</h1>
          <chat-composer
            .skills=${this.app?.locationSkills ?? null}
            .location=${this.placement}
            .commands=${this.app?.commands ?? null}
            .uploadAttachments=${this.upload}
            .submit=${this.submit}
            placeholder=${this.view.projectId == null ? "Choose a project, then describe the work…" : "Describe the work, or ask a question…"}
            ?disabled=${this.view.projectId == null}
          ></chat-composer>
          <div data-role="choices" class="mt-1.5 flex min-w-0 flex-wrap items-center gap-1 pl-[2.625rem]">
            ${this.renderProjectChoice()}
            ${this.renderTaskChoice()}
            ${this.renderLocationChoice()}
            <model-picker caption="For the session this page starts." .model=${this.model ?? this.defaultModel} .choose=${this.chooseModel}></model-picker>
          </div>
        </div>
        <location-dialog></location-dialog>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "new-session-page": NewSessionPage;
  }
}
