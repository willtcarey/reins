/**
 * The new session page: a project, a task and a model to choose, and a composer. Nothing is created
 * until its first message is sent (`NewSessionDraft`); then the page is replaced by the session's, and
 * the message flies into the session's conversation (`SendHandoff`).
 */

import { LitElement, html, type PropertyValues } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import type { ModelSetting } from "@backend/settings-store.js";
import { api } from "../models/api.js";
import { NewSessionDraft, type NewSessionDraftBacking, type NewSessionPlace } from "../models/new-session-draft.js";
import type { AppStore } from "../models/stores/app-store.js";
import { uploadSessionAttachments } from "../models/stores/active-session-store.js";
import type { ProjectStore } from "../models/stores/project-store.js";
import type { ProjectsStore } from "../models/stores/projects-store.js";
import { StoreController } from "../controllers/store-controller.js";
import { navigate, navigateToSession, newSessionHash } from "../routing/app-router.js";
import type { ChatComposer, DraftAttachment } from "./chat-composer.js";
import type { ChatComposerSubmitDetail } from "./events.js";
import { branchIcon, conversationIcon, folderIcon } from "../ui/icons.js";
import "../ui/choice-menu.js";
import "../ui/choice-selector.js";
import "./chat-composer.js";
import "./model-picker.js";

/** The new session page in the main area, with the project and task chosen in it so far. */
export type NewSessionView = { view: "new-session"; projectId: number | null; taskId: number | null };

declare module "@reins/sdk" {
  interface ViewTypes {
    "new-session": NewSessionView;
  }
}

function draftBacking(app: AppStore): NewSessionDraftBacking {
  return {
    createSession: async (projectId, input) => {
      const result = await app.projectsStore.createSession(projectId, input);
      if ("error" in result) throw new Error(result.error);
      return result.sessionId;
    },
    setModel: async (sessionId, model) => {
      app.sessionCache.set(sessionId, await app.sessionOperations.setModel(sessionId, model));
    },
    uploadAttachments: uploadSessionAttachments,
    submitPrompt: (sessionId, content) => {
      const submission = app.sessionOperations.submit(sessionId, "prompt", content);
      // The conversation shows a refusal; the session's details then say it is not running.
      submission?.admitted.catch(() => { void app.sessionCache.fetchDetail(sessionId); });
      return submission?.entry ?? null;
    },
  };
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

  @query("chat-composer") private composer?: ChatComposer;

  private draft: NewSessionDraft | null = null;
  private projects = new StoreController<ProjectsStore>(this);
  private project = new StoreController<ProjectStore>(this);

  override connectedCallback() {
    super.connectedCallback();
    void this.loadDefaultModel();
  }

  override willUpdate(changed: PropertyValues<this>) {
    if (changed.has("app")) {
      this.draft = this.app ? new NewSessionDraft(draftBacking(this.app)) : null;
      this.projects.store = this.app?.projectsStore ?? null;
    }
    if (changed.has("app") || changed.has("view")) {
      const { projectId } = this.view;
      const projectsStore = this.app?.projectsStore;
      this.project.store = projectsStore && projectId != null ? projectsStore.getStore(projectId) : null;
      if (projectsStore && projectId != null) void projectsStore.ensureLoaded(projectId);
    }
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

  private get place(): NewSessionPlace | null {
    const { projectId, taskId } = this.view;
    return projectId == null ? null : { projectId, taskId };
  }

  private requirePlace(): NewSessionPlace {
    const place = this.place;
    if (!place) throw new Error("Choose a project to start a session in");
    return place;
  }

  /** The page's URL holds its choices, so they last a reload and are what commands see. */
  private choose(projectId: number | null, taskId: number | null) {
    navigate(newSessionHash({ projectId, taskId }), true);
  }

  private chooseModel = (model: ModelSetting) => {
    this.model = model;
    if (this.draft) this.draft.model = model;
  };

  private upload = (attachments: readonly DraftAttachment[]) => {
    if (!this.draft) throw new Error("The page is not ready yet");
    return this.draft.upload(this.requirePlace(), attachments);
  };

  private submit = async ({ content, source }: ChatComposerSubmitDetail) => {
    if (!this.draft || !this.app) throw new Error("The page is not ready yet");
    const { sessionId, messageKey } = await this.draft.send(this.requirePlace(), content);
    if (source) this.app.sendHandoff.give({ sessionId, messageKey, source });
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

  override render() {
    return html`
      <div class="flex h-full flex-col overflow-y-auto px-4 pb-[var(--input-bottom)]">
        <div class="m-auto w-full max-w-2xl py-8">
          <h1 class="mb-6 text-center text-2xl font-medium text-zinc-200">What do you want to work on?</h1>
          <chat-composer
            .projectStore=${this.project.store}
            .commands=${this.app?.commands ?? null}
            .uploadAttachments=${this.upload}
            .submit=${this.submit}
            placeholder=${this.view.projectId == null ? "Choose a project, then describe the work…" : "Describe the work, or ask a question…"}
            ?disabled=${this.view.projectId == null}
          ></chat-composer>
          <div data-role="choices" class="mt-1.5 flex min-w-0 flex-wrap items-center gap-1 pl-[2.625rem]">
            ${this.renderProjectChoice()}
            ${this.renderTaskChoice()}
            <model-picker caption="For the session this page starts." .model=${this.model ?? this.defaultModel} .choose=${this.chooseModel}></model-picker>
          </div>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "new-session-page": NewSessionPage;
  }
}
