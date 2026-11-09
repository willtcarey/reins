/**
 * `reins.secrets`, the secrets extension's scripting functions: an agent requests values from the user, and reads
 * one by the handle the user's answer gave it.
 */

import { Type, type Static, type TSchema } from "@sinclair/typebox";
import type { ScriptContext, ScriptMethod, ScriptNamespace, ScriptParam } from "@reins/sdk/server";
import type { Secrets } from "./secrets.js";

const scriptMethod = <const P extends readonly ScriptParam[], R extends TSchema>(method: ScriptMethod<ScriptContext, P, R, Static<R>>) => method;

export function secretsScripting(secrets: Secrets): ScriptNamespace {
  return { namespace: "secrets", methods: { request: requestMethod(secrets), get: getMethod(secrets) } };
}

const requestMethod = (secrets: Secrets) => scriptMethod({
  description:
    "Ask the user for credentials or other sensitive values (API keys, tokens, passwords): they enter them in a masked form in " +
    "this session, and the values never enter the conversation. Never ask the user to paste one into the chat. Returns at once: " +
    "end your turn then, and tell the user. A message wakes this session once they answer, with a handle for each value " +
    "(reins.secrets.get), or saying they cancelled.\n\n" +
    "Ask for every variable you know is needed in one request. Find the names in documentation or .env.example, but do not read " +
    "or print an env file that holds secrets. Give a short purpose and a plain description of each name.\n\n" +
    "  return await reins.secrets.request({ names: [\"OPENAI_API_KEY\"], purpose: \"Configure the server\", descriptions: { OPENAI_API_KEY: \"OpenAI API key used by the server\" } });",
  params: [{
    name: "request",
    schema: Type.Object({
      names: Type.Array(Type.String(), { description: "Environment variable names: a letter or underscore, then letters, digits and underscores." }),
      purpose: Type.Optional(Type.String({ maxLength: 500, description: "Why they are needed, in a short sentence the user reads." })),
      descriptions: Type.Optional(Type.Record(Type.String(), Type.String({ maxLength: 300 }), { description: "A short, plain description of each name." })),
    }),
  }],
  returns: Type.Object({ requested: Type.Array(Type.String()), next: Type.String() }),
  tags: ["secrets", "secret", "credentials", "api key", "token", "password", "env", "dotenv", "ask", "user"],
  run: async (context, input) => secrets.request(context.sessionId, input),
});

const getMethod = (secrets: Secrets) => scriptMethod({
  description:
    "A stored secret's value, by the handle (sec_…) the user's answer to reins.secrets.request gave you. Give it to a command as " +
    "`env` in reins.nodes.run and refer to it there as $NAME: never put it in the command's text, the script's result, a message, " +
    "a log or a comment. After writing it to a file, trust the command's exit code: never read the file back (cat, sed, env, grep).\n\n" +
    "  const key = await reins.secrets.get(\"sec_…\");\n" +
    "  await reins.nodes.run(\"current\", 'printf \"%s\\\\n\" \"OPENAI_API_KEY=$OPENAI_API_KEY\" >> .env', { cwd: \"/path/to/project\", env: { OPENAI_API_KEY: key } });",
  params: [{ name: "handle", schema: Type.String() }],
  returns: Type.String(),
  tags: ["secrets", "secret", "credentials", "handle", "value", "env"],
  run: async (_context, handle) => secrets.get(handle),
});
