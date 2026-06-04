import type { AgentSession } from "@mariozechner/pi-coding-agent";
import { hydratePromptContent } from "../../session-attachments-store.js";
import { toPiThinkingLevel } from "./session.js";
import type {
  AgentRuntime,
  AgentRuntimeEvent,
  RuntimeMessage,
  RuntimeContentBlock,
  RuntimeHydratedPromptContent,
  RuntimeInlineImageBlock,
  RuntimePromptContent,
  SetRuntimeModelParams,
} from "../registry.js";

type PiRuntimeMessageBase = {
  summary?: string;
  stopReason?: string;
  [key: string]: unknown;
};

type PiMessageContent = RuntimeContentBlock[] | string;

type PiUserMessage = PiRuntimeMessageBase & {
  role: "user";
  content: PiMessageContent;
};

type PiAssistantMessage = PiRuntimeMessageBase & {
  role: "assistant";
  content: PiMessageContent;
};

type PiToolResultMessage = PiRuntimeMessageBase & {
  role: "toolResult";
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  content: PiMessageContent;
};

type PiCompactionSummaryMessage = PiRuntimeMessageBase & {
  role: "compactionSummary";
  content?: string;
};

type PiRuntimeMessage = PiUserMessage | PiAssistantMessage | PiToolResultMessage | PiCompactionSummaryMessage;

function textBlock(text: string): RuntimeContentBlock {
  return { type: "text", text };
}

function normalizePiRuntimeMessage(message: PiRuntimeMessage): RuntimeMessage {
  if (message.role === "compactionSummary") {
    const { content, ...rest } = message;
    return {
      ...rest,
      summary: message.summary ?? (typeof content === "string" ? content : ""),
    };
  }

  const { content, ...rest } = message;
  if (typeof content === "string") {
    return { ...rest, content: [textBlock(content)] };
  }

  return { ...rest, content };
}

function runtimePromptToTextAndImages(content: RuntimeHydratedPromptContent): {
  text: string;
  images: RuntimeInlineImageBlock[];
} {
  const textParts: string[] = [];
  const images: RuntimeInlineImageBlock[] = [];
  for (const block of content) {
    if (block.type === "text") {
      textParts.push(block.text);
    } else {
      images.push(block);
    }
  }
  return { text: textParts.join("\n"), images };
}

/**
 * Assert that a value is an AgentRuntimeEvent.
 * PI AgentSessionEvent and AgentRuntimeEvent share structure by design.
 */
function assertRuntimeEvent(_value: unknown): asserts _value is AgentRuntimeEvent {
  // PI session events are structurally compatible with AgentRuntimeEvent
}

/**
 * Assert that a value is a PI runtime message array.
 * PI may use string text content; normalize it at this adapter boundary before
 * handing messages to Reins persistence.
 */
function assertPiRuntimeMessages(_value: unknown): asserts _value is PiRuntimeMessage[] {
  // PI session messages match PiRuntimeMessage by design
}

export class PiAgentRuntime implements AgentRuntime {
  readonly runtimeType = "pi" as const;

  constructor(
    public readonly session: AgentSession,
    private readonly sessionId: string,
  ) {}

  async prompt(content: RuntimePromptContent): Promise<void> {
    const hydrated = hydratePromptContent(this.sessionId, content);
    const { text, images } = runtimePromptToTextAndImages(hydrated);
    if (images.length > 0) {
      await this.session.prompt(text, { images });
    } else {
      await this.session.prompt(text);
    }
  }

  async steer(content: RuntimePromptContent): Promise<void> {
    const hydrated = hydratePromptContent(this.sessionId, content);
    const { text, images } = runtimePromptToTextAndImages(hydrated);
    if (images.length > 0) {
      await this.session.steer(text, images);
    } else {
      await this.session.steer(text);
    }
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

  async getMessages(): Promise<RuntimeMessage[]> {
    const messages = this.session.messages;
    assertPiRuntimeMessages(messages);
    return messages.map(normalizePiRuntimeMessage);
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
