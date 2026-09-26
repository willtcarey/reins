import { z } from "zod";

/** Wire v1 is independent of the in-process semantic contract. */
export const protocolVersion = 1;
export const capability = z.enum(["node.provision", "node.status"]);
export const helloParams = z.strictObject({
  minVersion: z.number().int().positive(), maxVersion: z.number().int().positive(),
  capabilities: z.array(z.string().min(1).max(128)).max(16), instanceId: z.string().min(1).max(128),
}).refine(value => value.minVersion <= value.maxVersion);
export const readyResult = z.strictObject({
  version: z.literal(1), capabilities: z.array(capability).max(16), epoch: z.string().uuid(),
});
export const binding = z.strictObject({
  sourceId: z.number().int().positive(), cwd: z.string().min(1).max(4096),
  createdAt: z.string().min(1).max(128), parentSessionId: z.string().min(1).nullable(),
});
export const provisionParams = z.strictObject({
  epoch: z.string().uuid(), sessionId: z.string().min(1).max(128),
  commandId: z.string().min(1).max(128), binding,
});
export const provisionResult = z.strictObject({ provisioned: z.literal(true) });
export const statusParams = z.strictObject({ epoch: z.string().uuid(), sessionId: z.string().min(1).max(128) });
export const statusResult = z.strictObject({ provisioned: z.boolean() });
export type Provision = Omit<z.infer<typeof provisionParams>, "epoch">;
export type Ready = z.infer<typeof readyResult>;
export type Hello = z.infer<typeof helloParams>;
export type Status = z.infer<typeof statusResult>;
