import type { AgentSession, AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import { parseThinkingLevel } from "../../models/model-settings.js";
import type {
  AgentRuntime,
  AgentRuntimeEvent,
  AgentRuntimeMessage,
  RuntimeCompactionEvent,
  SetRuntimeModelParams,
} from "../registry.js";

function normalizePiSessionEvent(event: AgentSessionEvent): AgentRuntimeEvent {
  if (event.type === "auto_compaction_start") {
    const normalized: RuntimeCompactionEvent = {
      type: "compaction_start",
      reason: event.reason ?? "auto",
    };
    return normalized;
  }

  if (event.type === "auto_compaction_end") {
    const normalized: RuntimeCompactionEvent = {
      type: "compaction_end",
      result: event.result,
      aborted: event.aborted,
      errorMessage: event.errorMessage,
    };
    return normalized;
  }

  return event;
}

export class PiAgentRuntime implements AgentRuntime {
  readonly runtimeType = "pi" as const;

  constructor(
    public readonly session: AgentSession,
  ) {}

  async prompt(text: string): Promise<void> {
    await this.session.prompt(text);
  }

  async steer(text: string): Promise<void> {
    await this.session.steer(text);
  }

  async abort(): Promise<void> {
    await this.session.abort();
  }

  async setModel(params: SetRuntimeModelParams): Promise<void> {
    const providers = Array.from(new Set(this.session.modelRegistry.getAll().map((candidate) => candidate.provider))).toSorted();
    if (!providers.includes(params.provider)) {
      throw new Error(
        `Unknown provider '${params.provider}'. Available providers: ${providers.join(", ")}`,
      );
    }

    const models = this.session.modelRegistry.getAll().filter((candidate) => candidate.provider === params.provider);
    const model = models.find((candidate) => candidate.id === params.modelId);
    if (!model) {
      throw new Error(
        `Model '${params.modelId}' not found for provider '${params.provider}'. ` +
        `Available models: ${models.map((candidate) => candidate.id).join(", ")}`,
      );
    }

    await this.session.setModel(model);
    if (params.thinkingLevel) {
      this.session.setThinkingLevel(parseThinkingLevel(params.thinkingLevel));
    }
  }

  subscribe(listener: (event: AgentRuntimeEvent) => void): () => void {
    const unsubscribe = this.session.subscribe((event) => {
      listener(normalizePiSessionEvent(event));
    });
    return typeof unsubscribe === "function" ? unsubscribe : () => {};
  }

  async getMessages(): Promise<AgentRuntimeMessage[]> {
    return this.session.messages as unknown as AgentRuntimeMessage[];
  }

  getSessionMetadata(): { model?: { provider: string; modelId: string } | null; thinkingLevel?: string | null } {
    return {
      model: this.session.model
        ? { provider: this.session.model.provider, modelId: this.session.model.id }
        : null,
      thinkingLevel: this.session.thinkingLevel ?? null,
    };
  }

  isStreaming(): boolean {
    return this.session.isStreaming;
  }

  async close(): Promise<void> {
    this.session.dispose();
  }
}

type PiRuntimeLike = AgentRuntime & {
  runtimeType?: string;
  session: AgentSession;
};

export function isPiRuntime(runtime: AgentRuntime): runtime is PiRuntimeLike {
  const candidate: Partial<PiRuntimeLike> = runtime;
  return !!candidate.session && (candidate.runtimeType === undefined || candidate.runtimeType === "pi");
}

export function getPiSession(runtime: AgentRuntime): AgentSession {
  if (!isPiRuntime(runtime)) {
    throw new Error("Runtime is not a pi runtime");
  }
  return runtime.session;
}
