import type { AgentSession } from "@mariozechner/pi-coding-agent";
import { toPiThinkingLevel } from "./session.js";
import type {
  AgentRuntime,
  AgentRuntimeEvent,
  AgentRuntimeMessage,
  SetRuntimeModelParams,
} from "../registry.js";

/**
 * Assert that a value is an AgentRuntimeEvent.
 * PI AgentSessionEvent and AgentRuntimeEvent share structure by design.
 */
function assertRuntimeEvent(_value: unknown): asserts _value is AgentRuntimeEvent {
  // PI session events are structurally compatible with AgentRuntimeEvent
}

/**
 * Assert that a value is an AgentRuntimeMessage[].
 * PI AgentMessage[] is structurally compatible with AgentRuntimeMessage[].
 */
function assertRuntimeMessages(_value: unknown): asserts _value is AgentRuntimeMessage[] {
  // PI session messages match AgentRuntimeMessage by design
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
      this.session.setThinkingLevel(toPiThinkingLevel(params.thinkingLevel));
    }
  }

  subscribe(listener: (event: AgentRuntimeEvent) => void): () => void {
    const unsubscribe = this.session.subscribe((event) => {
      assertRuntimeEvent(event);
      listener(event);
    });
    return typeof unsubscribe === "function" ? unsubscribe : () => {};
  }

  async getMessages(): Promise<AgentRuntimeMessage[]> {
    const messages = this.session.messages;
    assertRuntimeMessages(messages);
    return messages;
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
