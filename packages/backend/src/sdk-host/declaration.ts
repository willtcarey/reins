/**
 * The server SDK's capabilities, declared once (docs/dev/server-sdk.md *One layer*): each method that agents'
 * scripts may call is a `ScriptMethod` of `@reins/sdk/server`, its schemas beside its implementation. `bind`
 * makes a namespace the SDK object of one caller: an extension (`ServerSdk`), or an agent's session, whose
 * script gets it as `api` (`projection.ts`, which documents and checks it from the same declaration).
 */

import { Type, type Static, type TSchema } from "@sinclair/typebox";
import type { JsonSchema, ScriptArgs, ScriptMethod, ScriptParam } from "@reins/sdk/server";
import type { Models } from "../models/models.js";
import type { SessionModel } from "../models/session.js";
import type { SessionInstance } from "../sessions/session-instance.js";

/** Who calls an SDK method: an agent's session (its script: defaults are its own, and what it does is
 * attributed to it), or an extension (it acts as no session). */
export type Caller =
  | {
    kind: "session";
    /** As its row was when the script began. */
    session: SessionModel;
    instance?: SessionInstance;
    /** The script's: aborts when the script ends. */
    signal?: AbortSignal;
  }
  | { kind: "extension"; name: string };

/** What an SDK method runs with: the models of the call, and its caller. */
export interface CallContext {
  models: Models;
  caller: Caller;
}

/** A declared method in its stored form (method syntax: a namespace holds methods of different arguments). */
export interface SdkMethod {
  readonly description: string;
  readonly params: readonly ScriptParam[];
  readonly returns: JsonSchema;
  readonly tags: readonly string[];
  run(context: CallContext, ...args: any[]): Promise<unknown>;
  toScript?(result: any, ...args: any[]): unknown;
}

/** A namespace of the SDK: its methods that scripts may call, and the named types `search` shows by name. */
export interface SdkNamespace<M extends Record<string, SdkMethod> = Record<string, SdkMethod>> {
  readonly name: string;
  readonly methods: M;
  readonly types?: Readonly<Record<string, TSchema>>;
}

/** Declares a method: `run`'s arguments are typed by `params`, its result by `returns` (or `toScript`'s). */
export function sdkMethod<const P extends readonly ScriptParam[], R extends TSchema, T = Static<R>>(
  method: ScriptMethod<CallContext, P, R, T>,
): ScriptMethod<CallContext, P, R, T> {
  return method;
}

/** `methods` as one caller has them: each takes the declared arguments and resolves to `run`'s result. */
export type Bound<M> = {
  [K in keyof M]: M[K] extends { readonly params: infer P extends readonly ScriptParam[]; run(...args: any[]): Promise<infer T> }
    ? (...args: ScriptArgs<P>) => Promise<T>
    : never;
};

/** `methods` bound to the context `context()` gives at each call (an extension's models are the app's of that call). */
export function bind<M extends Record<string, SdkMethod>>(methods: M, context: () => CallContext): Bound<M>;
export function bind(methods: Record<string, SdkMethod>, context: () => CallContext): Record<string, (...args: unknown[]) => Promise<unknown>> {
  const bound: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const [name, method] of Object.entries(methods)) bound[name] = (...args) => method.run(context(), ...args);
  return bound;
}

/** An option for extensions only: `search` leaves it out, and a script may not give it. */
export const notForScripts = <T extends TSchema>(schema: T): T => ({ ...schema, scripts: false });

/** An extension's `signal` option; a script's calls have the script's. */
export const SignalSchema = notForScripts(Type.Unsafe<AbortSignal>({ description: "Aborts the call." }));

/** The signal of a call: the one given, else the script's, else one that never aborts. */
export function signalOf(context: CallContext, given?: AbortSignal): AbortSignal {
  return given ?? (context.caller.kind === "session" ? context.caller.signal : undefined) ?? new AbortController().signal;
}
