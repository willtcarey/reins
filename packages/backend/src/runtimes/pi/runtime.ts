import type { AgentSession } from "@mariozechner/pi-coding-agent";
import type { AgentRuntime } from "../registry.js";

export class PiAgentRuntime implements AgentRuntime {
  constructor(public readonly session: AgentSession) {}

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

  async close(): Promise<void> {
    this.session.dispose();
  }
}

export function isPiRuntime(runtime: AgentRuntime): runtime is PiAgentRuntime {
  return runtime instanceof PiAgentRuntime;
}

export function getPiSession(runtime: AgentRuntime): AgentSession {
  if (!isPiRuntime(runtime)) {
    throw new Error("Runtime is not a pi runtime");
  }
  return runtime.session;
}
