import type { AgentSession } from "@mariozechner/pi-coding-agent";
import type { AgentRuntime } from "../registry.js";

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

  subscribe(listener: (event: any) => void): () => void {
    const unsubscribe = this.session.subscribe(listener);
    return typeof unsubscribe === "function" ? unsubscribe : () => {};
  }

  async getMessages(): Promise<any[]> {
    return this.session.messages;
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
