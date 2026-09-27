/**
 * TEST HOOK ONLY. Process-level tests run the real node entrypoint in a child process, where they cannot
 * register a provider in-process; `main.ts` calls this only when `REINS_NODE_TEST_FAUX_PROVIDER` is set.
 * Registers a faux Pi provider (model `fake`) that answers every request with `Echo: <last user text>`.
 * A prompt containing `[slow:<ms>]` waits that long (or until aborted) before answering, so tests can
 * interrupt a run in flight. Never set in production.
 */
import { fauxAssistantMessage, fauxProvider, type Context, type FauxResponseFactory } from "@earendil-works/pi-ai";
import { registerPiProvider } from "../runtime/context.js";

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
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, Number(slow[1]));
        options?.signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
      });
    }
    return fauxAssistantMessage(`Echo: ${text}`);
  };
  faux.setResponses([respond]);
  registerPiProvider(faux.provider);
}
