/**
 * The secrets extension's HTTP API (`reins.http`), between its form and its backend part. Schemas only, so the
 * frontend part imports its type (`SecretsApi`). Values cross only in `submit`'s body, never in a message.
 */

import { Type } from "@sinclair/typebox";
import type { HttpApi } from "@reins/sdk/server";

const NullableString = Type.Union([Type.String(), Type.Null()]);
const RequestId = Type.Object({ id: Type.String({ minLength: 1, maxLength: 100 }) });

export const secretsApi = {
  /** The open requests, of every session, the oldest first. */
  requests: {
    output: Type.Array(Type.Object({
      id: Type.String(),
      sessionId: Type.String(),
      purpose: NullableString,
      fields: Type.Array(Type.Object({ name: Type.String(), description: NullableString })),
      createdAt: Type.String(),
    })),
  },
  /** The user's values for request `id`, by name: exactly its names. 404 once it has ended. */
  submit: {
    input: Type.Object({
      id: RequestId.properties.id,
      values: Type.Record(Type.String(), Type.String(), { maxProperties: 50 }),
    }),
  },
  /** The user does not answer request `id`: its session is told. 404 once it has ended. */
  cancel: { input: RequestId },
  /** The stored secrets, without their values or handles, the newest first. */
  stored: {
    output: Type.Array(Type.Object({
      id: Type.Integer(),
      name: Type.String(),
      sessionId: Type.String(),
      createdAt: Type.String(),
      lastUsedAt: NullableString,
    })),
  },
  /** Deletes a stored secret: its handle no longer works. */
  remove: { input: Type.Object({ id: Type.Integer() }) },
} satisfies HttpApi;

export type SecretsApi = typeof secretsApi;
