/**
 * The SDK as agents' scripts get it (docs/dev/server-sdk.md *Scripts*): each declared method as a function of
 * `api`, documented by `search` from its declaration and called with a script's positional arguments, which are
 * checked against the declared schemas first. The caller is the script's session.
 */

import { types } from "node:util";
import { Type, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { ScriptParam } from "@reins/sdk/server";
import type { ApiContext, ApiFunctionDef } from "../scripting/define-function.js";
import { schemaAnyOf, schemaField, schemaItems, schemaProperties } from "../scripting/schema-utils.js";
import type { CallContext, SdkMethod, SdkNamespace } from "./declaration.js";

/** The context of a call from a script of the session `ctx` is about. */
export function scriptCallContext(ctx: ApiContext): CallContext {
  return {
    models: ctx.models,
    caller: { kind: "session", session: ctx.session, ...(ctx.instance ? { instance: ctx.instance } : {}), ...(ctx.signal ? { signal: ctx.signal } : {}) },
  };
}

/** The namespace's methods as `api`'s functions. */
export function scriptFunctions({ name: namespace, methods }: SdkNamespace): ApiFunctionDef[] {
  return Object.entries(methods).map(([name, method]) => scriptFunction(`${namespace}.${name}`, method));
}

/** The namespace's named types, for `search`. */
export function scriptTypes({ types: named = {} }: SdkNamespace): { name: string; schema: TSchema }[] {
  return Object.entries(named).map(([name, schema]) => ({ name, schema }));
}

function scriptFunction(name: string, method: SdkMethod): ApiFunctionDef {
  const params = method.params.flatMap(param => {
    const schema = forScripts(schemaOf(name, param.schema));
    return schema ? [{ ...param, schema }] : [];
  });
  return {
    name,
    description: method.description,
    parameters: parametersOf(params),
    returns: schemaOf(name, method.returns),
    async: true,
    tags: [...method.tags],
    async call(args, ctx) {
      const checked = checkedArgs(name, params, args);
      const result = await method.run(scriptCallContext(ctx), ...checked);
      return method.toScript ? method.toScript(result, ...checked) : result;
    },
  };
}

/** The params as `search` documents them: an object schema whose properties are the arguments, in order (the
 * params' own schemas, so that named types keep their names). */
function parametersOf(params: readonly (ScriptParam & { schema: TSchema })[]) {
  const object = Type.Object(Object.fromEntries(params.map(param => [param.name, param.schema])));
  const required = params.filter(param => !param.optional).map(param => param.name);
  return { ...object, required };
}

// The registry and the renderer read only JSON Schema fields, so any JSON Schema object works there.
function isSchema(schema: unknown): schema is TSchema {
  return typeof schema === "object" && schema !== null && !Array.isArray(schema);
}

function schemaOf(name: string, schema: unknown): TSchema {
  if (!isSchema(schema)) throw new Error(`${name}: not a JSON Schema object`);
  return schema;
}

/** `schema` without what is not for scripts (`scripts: false`), the same object when it has none; null when it
 * is not for scripts itself. */
function forScripts(schema: TSchema): TSchema | null {
  if (schemaField(schema, "scripts") === false) return null;
  const properties = schemaProperties(schema);
  if (schema.type === "object" && properties) {
    let changed = false;
    const kept: Record<string, TSchema> = {};
    for (const [key, property] of Object.entries(properties)) {
      const own = forScripts(property);
      if (own !== property) changed = true;
      if (own) kept[key] = own;
    }
    if (!changed) return schema;
    const required = schemaField(schema, "required");
    return { ...schema, properties: kept, ...(Array.isArray(required) ? { required: required.filter(key => key in kept) } : {}) };
  }
  const members = schemaAnyOf(schema);
  if (members) {
    const own = members.map(forScripts);
    return own.every((member, index) => member === members[index]) ? schema : { ...schema, anyOf: own.filter(member => member !== null) };
  }
  const items = schemaItems(schema);
  if (schema.type === "array" && items) {
    const own = forScripts(items);
    return own === items ? schema : own && { ...schema, items: own };
  }
  return schema;
}

/** The script's arguments, checked against their schemas, or a throw naming the first that is wrong. */
function checkedArgs(name: string, params: readonly (ScriptParam & { schema: TSchema })[], args: readonly unknown[]): unknown[] {
  const fn = `api.${name}`;
  if (args.length > params.length) throw new Error(`${fn} takes ${params.length === 0 ? "no arguments" : `at most ${params.length} argument${params.length === 1 ? "" : "s"} (${params.map(param => param.name).join(", ")})`}`);
  return params.map((param, index) => {
    const value = args[index];
    if (value === undefined) {
      if (!param.optional) throw new Error(`${fn}: ${param.name} is required`);
      return undefined;
    }
    const own = hostBytes(param.schema, value);
    const problem = mismatch(param.schema, own, param.name);
    if (problem) throw new Error(`${fn}: ${problem}`);
    return own;
  });
}

/** Where `value` does not match `schema`, or null. An object schema with properties takes no other keys: a
 * misspelt or renamed option is an error, not ignored. */
function mismatch(schema: TSchema, value: unknown, path: string): string | null {
  if (!Value.Check(schema, value)) {
    const first = Value.Errors(schema, value).First();
    return first ? `${path}${dotted(first.path)}: ${first.message}` : `${path} does not match`;
  }
  return unknownKey(schema, value, path);
}

function unknownKey(schema: TSchema, value: unknown, path: string): string | null {
  const members = schemaAnyOf(schema);
  if (members) {
    const matching = members.filter(member => Value.Check(member, value));
    const problems = matching.map(member => unknownKey(member, value, path));
    return problems.includes(null) ? null : problems[0] ?? null;
  }
  const items = schemaItems(schema);
  if (schema.type === "array" && items && Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const problem = unknownKey(items, item, `${path}[${index}]`);
      if (problem) return problem;
    }
    return null;
  }
  const properties = schemaProperties(schema);
  if (schema.type !== "object" || !properties || typeof value !== "object" || value === null) return null;
  for (const [key, item] of Object.entries(value)) {
    const property = properties[key];
    if (!property) {
      const fields = Object.keys(properties);
      return `${path} has no field ${JSON.stringify(key)}${fields.length > 0 ? ` (its fields: ${fields.join(", ")})` : ""}`;
    }
    const problem = unknownKey(property, item, `${path}.${key}`);
    if (problem) return problem;
  }
  return null;
}

/** A JSON pointer as a path's continuation: `/options/0/cwd` → `.options[0].cwd`. */
function dotted(pointer: string): string {
  return pointer.split("/").slice(1).map(part => /^\d+$/.test(part) ? `[${part}]` : `.${part}`).join("");
}

/** `value` with the script's byte arrays made the server's: a script runs in a context of its own, whose
 * `Uint8Array` is another class. */
function hostBytes(schema: TSchema, value: unknown): unknown {
  if (types.isUint8Array(value)) {
    const accepts = schema.type === "Uint8Array" || (schemaAnyOf(schema) ?? []).some(member => member.type === "Uint8Array");
    return accepts && Object.getPrototypeOf(value) !== Uint8Array.prototype ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : value;
  }
  const properties = schemaProperties(schema);
  if (schema.type === "object" && properties && typeof value === "object" && value !== null && !Array.isArray(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, properties[key] ? hostBytes(properties[key], item) : item]));
  }
  return value;
}
