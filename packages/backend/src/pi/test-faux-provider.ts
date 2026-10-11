/**
 * TEST HOOK ONLY. Process-level tests run the real server entrypoint in a child process, where they cannot
 * register a provider in-process; `start` (`server.ts`) calls this only when `REINS_TEST_FAUX_PROVIDER` is
 * set. Registers a faux Pi provider (model `fake`) with the server's model runtimes, where sessions run
 * (ADR-029), that answers every request with `Echo: <last user text>`. A prompt containing `[slow:<ms>]`
 * waits that long (or until aborted) before answering, so tests can interrupt a run in flight. One
 * containing `[tool]` is first answered with a bash call appending `ran` to `tool-runs.log` in the
 * session's checkout (on its node), then echoed, so tests can hold a run at a tool call and count its
 * runs. One containing `[docs]` is answered, in place of the echo, with the system prompt's line naming
 * the feature docs. Never set in production.
 */
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type Context, type FauxResponseFactory } from "@earendil-works/pi-ai";
import { registerPiProvider } from "./factory.js";
import { logger } from "../logger.js";

function lastUserText(context: Context): string {
  const message = context.messages.findLast(entry => entry.role === "user");
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  return message.content.map(block => block.type === "text" ? block.text : "").join("");
}

export function registerTestFauxProvider(providerId: string): void {
  const faux = fauxProvider({ provider: providerId, models: [{ id: "fake", input: ["text"], contextWindow: 200_000, maxTokens: 1_000 }] });
  const respond: FauxResponseFactory = async (context, options) => {
    faux.appendResponses([respond]);
    const text = lastUserText(context);
    const slow = /\[slow:(\d+)\]/.exec(text);
    if (slow) {
      logger.info(`[server] faux provider waiting for ${slow[1]}ms`);
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, Number(slow[1]));
        options?.signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
      });
    }
    if (text.includes("[tool]") && context.messages.at(-1)?.role !== "toolResult") {
      return fauxAssistantMessage(fauxToolCall("bash", { command: "echo ran >> tool-runs.log" }), { stopReason: "toolUse" });
    }
    if (text.includes("[docs]")) {
      return fauxAssistantMessage(context.systemPrompt?.split("\n").find(line => line.includes("Feature docs:")) ?? "No feature docs line");
    }
    return fauxAssistantMessage(`Echo: ${text}`);
  };
  faux.setResponses([respond]);
  registerPiProvider(faux.provider);
}
