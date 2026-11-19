/**
 * Pi's classifier models as decision models (docs/dev/server-sdk.md *Decisions*): those of the catalog whose
 * provider is signed in, asked through the server's model runtime with its credentials, as sessions' models
 * are. A model's ID is `<provider>/<id>`.
 */

import type { CredentialStore } from "@earendil-works/pi-ai";
import type { DecisionModel, DecisionRequest, DecisionResult } from "@reins/sdk/server";
import { createPiModelRuntime } from "./factory.js";

export async function listPiDecisionModels(credentials: CredentialStore, signal: AbortSignal): Promise<DecisionModel[]> {
  const runtime = await createPiModelRuntime({ credentials });
  return (await runtime.getAvailableOfType("classifier", undefined, { signal })).map(model => ({
    id: `${model.provider}/${model.id}`,
    name: model.name,
    input: [...model.input],
  }));
}

export async function classifyWithPi(credentials: CredentialStore, id: string, request: DecisionRequest, signal: AbortSignal): Promise<DecisionResult> {
  const at = id.indexOf("/");
  const provider = id.slice(0, at);
  const runtime = await createPiModelRuntime({ credentials });
  const model = at > 0 ? runtime.getModelOfType("classifier", provider, id.slice(at + 1)) : undefined;
  if (!model) throw new Error(`Unknown decision model: ${id}. List them with reins.decisions.list().`);
  if (request.images?.length && !model.input.includes("image")) throw new Error(`${id} does not take images`);
  const result = await runtime.classify(model, {
    state: request.state,
    ...(request.images ? { images: request.images } : {}),
    questions: request.questions,
  }, { signal, ...(request.temperature === undefined ? {} : { temperature: request.temperature }) });
  if (result.stopReason === "aborted" || signal.aborted) throw signal.reason ?? new Error(result.errorMessage ?? "Aborted");
  if (result.stopReason === "error") throw new Error(`${id}: ${result.errorMessage ?? "the classification failed"}`);
  return {
    answers: result.answers,
    ...(result.usage ? { usage: { input: result.usage.input, output: result.usage.output, cost: result.usage.cost.total } } : {}),
  };
}
