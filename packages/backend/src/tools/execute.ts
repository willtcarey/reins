/**
 * Server side of the `execute` agent tool (`ReinsToolCalls.executeScript`).
 *
 * Runs agent-written async JavaScript against a curated `api` object that exposes Reins-managed
 * data and UI state, scoped to the calling session. The tool definition lives on the node
 * (`runtime/reins-tools.ts` in the node package); the server only runs the script.
 *
 * Code runs inside a Node.js `vm` context so it cannot access the host process, filesystem,
 * network, or native modules. Only the `api` object and safe JS builtins are available.
 *
 * NOTE: The vm sandbox is a lightweight isolation layer — it prevents accidental misuse and casual
 * prompt-injection exploits but is NOT a security boundary against a determined attacker. See
 * docs/tech-debt.md for notes on upgrading to a child-process sandbox if needed.
 */

import { createContext, runInContext } from "node:vm";
import { buildApiObject, scriptingApi } from "../scripting/api-registry.js";
import type { ApiContext } from "../scripting/define-function.js";
import { formatValue, scriptOutput, type ScriptContentBlock } from "./script-output.js";

/** Bounds synchronous script execution only; awaited API calls (e.g. `sessions.wait`) are bounded by their own limits and `signal`. */
const TIMEOUT_MS = 30_000;

/**
 * A script that throws is a completed call: its error message reaches the model unchanged. `content` is there
 * when the script called `text()` or `image()`: their blocks, then the return value. `text` stays for a session
 * runtime of older code (`App.executeScript`).
 */
export type ScriptExecuteResult = { ok: true; text: string; content?: ScriptContentBlock[] } | { ok: false; error: string };

/** A script that throws is a completed call: its message is returned for the model unchanged. */
export async function runScript(ctx: ApiContext, code: string): Promise<ScriptExecuteResult> {
  try {
    const api = buildApiObject(ctx, scriptingApi(ctx.models.extensions).functions);
    const output = scriptOutput();

    // Build a vm context with only the api object and safe JS builtins.
    // This prevents access to process, require, import(), fs, network, etc.
    const vmContext = createContext({
      api,
      ...output.globals,
      // Safe builtins
      JSON,
      Math,
      Date,
      Array,
      Object,
      String,
      Number,
      Boolean,
      RegExp,
      Error,
      TypeError,
      RangeError,
      Map,
      Set,
      WeakMap,
      WeakSet,
      Promise,
      Symbol,
      parseInt,
      parseFloat,
      isNaN,
      isFinite,
      undefined,
      NaN,
      Infinity,
      // Logging (captured, not host console)
      console: { log: () => {}, warn: () => {}, error: () => {} },
    });

    // Wrap the agent's code in an async IIFE so `return` and `await` work.
    // The trailing newline ensures a closing `//` comment doesn't eat the `})`.
    const wrapped = `(async function(api) { ${code}\n})(api)`;
    const result = await runInContext(wrapped, vmContext, { timeout: TIMEOUT_MS });
    const content = await output.blocks();
    if (content.length === 0) return { ok: true, text: formatValue(result) };
    if (result !== undefined) content.push({ type: "text", text: formatValue(result) });
    const text = content.flatMap(block => block.type === "text" ? [block.text] : []).join("\n");
    return { ok: true, text, content };
  } catch (err: any) {
    return { ok: false, error: String(err?.message) };
  }
}
