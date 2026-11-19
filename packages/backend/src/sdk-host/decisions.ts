/**
 * `decisions` (docs/dev/server-sdk.md *Decisions*): decision (classifier) models, listed and used by an
 * extension and an agent's script alike. Pi's catalog is the built-in provider (`pi/decisions.ts`, IDs
 * `<provider>/<id>`); each extension may register one more (`reins.decisions.registerProvider`, IDs
 * `<extension>__<model>`). Questions are checked before, and answers after, whoever answers.
 */

import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { DecisionAnswer, DecisionModel, DecisionQuestion, DecisionRequest, DecisionResult, ScriptNamespace } from "@reins/sdk/server";
import { classifyWithPi, listPiDecisionModels } from "../pi/decisions.js";
import type { Models } from "../models/models.js";
import { getSetting } from "../settings-store.js";
import { collectImages, formatValue } from "../tools/script-output.js";
import { SignalSchema, sdkMethod, signalOf, type CallContext } from "./declaration.js";

const SEPARATOR = "__";

const Instructions = Type.String({ minLength: 1, description: "The question, as the model is asked it." });

const QuestionSchema = Type.Union([
  Type.Object({
    type: Type.Literal("choice"),
    instructions: Instructions,
    criteria: Type.Record(Type.String({ minLength: 1 }), Type.String(), { minProperties: 2, description: "Each choice, by its key, with what it means." }),
  }, { additionalProperties: false }),
  Type.Object({
    type: Type.Literal("bool"),
    instructions: Instructions,
    criteria: Type.Object({ true: Type.String(), false: Type.String() }, { additionalProperties: false, description: "What true and false mean." }),
  }, { additionalProperties: false }),
  Type.Object({
    type: Type.Literal("score"),
    instructions: Instructions,
    criteria: Type.Array(Type.String(), { minItems: 2, description: "Each level, lowest first." }),
  }, { additionalProperties: false }),
]);

const QuestionsSchema = Type.Record(Type.String({ minLength: 1 }), QuestionSchema, { minProperties: 1, description: "The questions, by ID. One call answers them all." });

const Probability = Type.Number({ minimum: 0, maximum: 1 });

const AnswerSchemas = {
  choice: Type.Object({
    type: Type.Literal("choice"),
    choice: Type.String({ description: "A key of the question's criteria." }),
    probabilities: Type.Record(Type.String(), Probability, { description: "Of each choice." }),
    confidence: Probability,
  }),
  bool: Type.Object({ type: Type.Literal("bool"), probability: Type.Number({ minimum: 0, maximum: 1, description: "Of true." }) }),
  score: Type.Object({ type: Type.Literal("score"), score: Type.Number({ description: "The expected level, from 0 to criteria.length - 1." }), confidence: Probability }),
};

const AnswerSchema = Type.Union([AnswerSchemas.choice, AnswerSchemas.bool, AnswerSchemas.score]);

const UsageSchema = Type.Object({
  input: Type.Number({ minimum: 0, description: "Tokens." }),
  output: Type.Number({ minimum: 0, description: "Tokens." }),
  cost: Type.Number({ minimum: 0, description: "USD." }),
});

const DecisionModelSchema = Type.Object({
  id: Type.String({ description: "For decisions.classify." }),
  name: Type.String(),
  input: Type.Array(Type.Union([Type.Literal("text"), Type.Literal("image")]), { description: "\"image\": it judges images with the state." }),
});

/** A decision model as `decisions.list` and `GET /api/decisions/models` give it. */
export type DecisionModelView = Static<typeof DecisionModelSchema>;

const DecisionResultSchema = Type.Object({
  model: Type.String(),
  answers: Type.Record(Type.String(), AnswerSchema, { description: "One for each question, by its ID." }),
  usage: Type.Optional(UsageSchema),
});

const ClassifyOptionsSchema = Type.Object({
  model: Type.Optional(Type.String({ description: "An ID from decisions.list. By default the decision model chosen in Settings." })),
  state: Type.Record(Type.String(), Type.Unknown(), { description: "What to judge: a JSON object." }),
  images: Type.Optional(Type.Unknown({ description: "Images judged with the state, for a model whose input has \"image\": anything image() takes." })),
  questions: QuestionsSchema,
  temperature: Type.Optional(Type.Number({ exclusiveMinimum: 0, description: "Above 1 softens the probabilities, below 1 sharpens them. Not every model applies it." })),
  signal: Type.Optional(SignalSchema),
});

type ClassifyOptions = Static<typeof ClassifyOptionsSchema>;

/** Where models come from: Pi's catalog, or an extension's provider. */
interface Source {
  classify(model: string, request: DecisionRequest, signal: AbortSignal): Promise<DecisionResult>;
}

function firstProblem(schema: TSchema, value: unknown): string {
  const error = Value.Errors(schema, value).First();
  return error ? `${error.path || "/"} ${error.message}` : "invalid";
}

/** An extension's model IDs are `<extension>__<model>`: a `__` before any `/`, which Pi's `<provider>/<id>` never has. */
function extensionOf(id: string): { extension: string; model: string } | undefined {
  const at = id.indexOf(SEPARATOR);
  const slash = id.indexOf("/");
  if (at <= 0 || (slash >= 0 && slash < at)) return undefined;
  return { extension: id.slice(0, at), model: id.slice(at + SEPARATOR.length) };
}

function piSource(context: CallContext): Source {
  return {
    classify: (model, request, signal) => classifyWithPi(context.models.credentials, model, request, signal),
  };
}

function extensionSource(context: CallContext, extension: string, id: string): Source | undefined {
  const provider = context.models.extensions.decisionProviders.get(extension);
  if (!provider) return undefined;
  return {
    async classify(model, request, signal) {
      const found = (await provider.list(signal)).find(entry => entry.id === model);
      if (!found) throw new Error(`Unknown decision model: ${id}. List them with reins.decisions.list().`);
      if (request.images?.length && !found.input.includes("image")) throw new Error(`${id} does not take images`);
      return provider.classify(model, request, signal);
    },
  };
}

/** Pi's, then each extension's; also the models Settings offers as the default (`GET /api/decisions/models`). */
export async function listDecisionModels(models: Models, signal: AbortSignal): Promise<DecisionModel[]> {
  const extensions = await Promise.all([...models.extensions.decisionProviders].map(async ([extension, provider]) =>
    (await provider.list(signal)).map(model => ({ id: `${extension}${SEPARATOR}${model.id}`, name: model.name, input: [...model.input] }))));
  return [...await listPiDecisionModels(models.credentials, signal), ...extensions.flat()];
}

/** `answers` as `questions` ask them, with only the documented fields; a throw names the first problem. */
function checkAnswers(questions: Record<string, DecisionQuestion>, answers: unknown): Record<string, DecisionAnswer> {
  if (typeof answers !== "object" || answers === null || Array.isArray(answers)) return malformed(`answers is ${formatValue(answers).slice(0, 80)}, not an object`);
  const given: Record<string, unknown> = { ...answers };
  const extra = Object.keys(given).find(id => !Object.hasOwn(questions, id));
  if (extra !== undefined) return malformed(`an answer to ${extra}, which was not asked`);
  const checked: Record<string, DecisionAnswer> = {};
  for (const [id, question] of Object.entries(questions)) {
    if (!Object.hasOwn(given, id)) return malformed(`no answer to ${id}`);
    checked[id] = checkAnswer(id, question, given[id]);
  }
  return checked;
}

function checkAnswer(id: string, question: DecisionQuestion, answer: unknown): DecisionAnswer {
  const type = typeof answer === "object" && answer !== null && "type" in answer ? answer.type : undefined;
  if (typeof type === "string" && type !== question.type && Object.hasOwn(AnswerSchemas, type)) return malformed(`${id}: a ${type} answer to a ${question.type} question`);
  const schema = AnswerSchemas[question.type];
  if (!Value.Check(schema, answer)) return malformed(`${id}: ${firstProblem(schema, answer)}`);
  if (answer.type === "choice" && question.type === "choice") {
    if (!Object.hasOwn(question.criteria, answer.choice)) return malformed(`${id}: ${answer.choice} is not one of its choices`);
    const unknown = Object.keys(answer.probabilities).find(key => !Object.hasOwn(question.criteria, key));
    if (unknown !== undefined) return malformed(`${id}: a probability for ${unknown}, which is not one of its choices`);
    return { type: "choice", choice: answer.choice, probabilities: { ...answer.probabilities }, confidence: answer.confidence };
  }
  if (answer.type === "score" && question.type === "score") {
    const top = question.criteria.length - 1;
    if (answer.score < 0 || answer.score > top) return malformed(`${id}: score ${answer.score} is not from 0 to ${top}`);
    return { type: "score", score: answer.score, confidence: answer.confidence };
  }
  if (answer.type === "bool") return { type: "bool", probability: answer.probability };
  return malformed(`${id}: a ${answer.type} answer to a ${question.type} question`);
}

class MalformedAnswers extends Error {}

function malformed(problem: string): never {
  throw new MalformedAnswers(problem);
}

function checkResult(model: string, questions: Record<string, DecisionQuestion>, result: unknown): Static<typeof DecisionResultSchema> {
  try {
    const given = typeof result === "object" && result !== null ? result : {};
    const answers = checkAnswers(questions, "answers" in given ? given.answers : undefined);
    const usage = "usage" in given ? given.usage : undefined;
    if (usage === undefined) return { model, answers };
    if (!Value.Check(UsageSchema, usage)) return malformed(`usage: ${firstProblem(UsageSchema, usage)}`);
    return { model, answers, usage: { input: usage.input, output: usage.output, cost: usage.cost } };
  } catch (error) {
    if (error instanceof MalformedAnswers) throw new Error(`${model} gave malformed answers: ${error.message}`, { cause: error });
    throw error;
  }
}

/** The projection checks a script's options before the call, but an extension's come here unchecked. */
function checkOptions({ signal: _signal, ...options }: ClassifyOptions): void {
  if (Value.Check(ClassifyOptionsSchema, options)) return;
  const error = Value.Errors(ClassifyOptionsSchema, options).First();
  throw new Error(`decisions.classify: ${error?.path.replace(/^\//, "") || "options"}: ${error?.message ?? "invalid"}`);
}

/** A provider that does not stop at the abort is left to finish on its own. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

async function classify(context: CallContext, options: ClassifyOptions) {
  checkOptions(options);
  const signal = signalOf(context, options.signal);
  const model = options.model ?? getSetting("decision_model");
  if (!model) throw new Error("No decision model: give one (reins.decisions.list()), or choose a default in Settings → Models → Decision model");
  const extension = extensionOf(model);
  const source = extension ? extensionSource(context, extension.extension, model) : piSource(context);
  if (!source) throw new Error(`Unknown decision model: ${model}. List them with reins.decisions.list().`);
  const request: DecisionRequest = {
    // A JSON copy: what every provider sends, and plain objects rather than a script vm's.
    state: JSON.parse(JSON.stringify(options.state)),
    ...(options.images === undefined ? {} : { images: collectImages(options.images) }),
    questions: options.questions,
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
  };
  signal.throwIfAborted();
  const result = await untilAborted(source.classify(extension?.model ?? model, request, signal), signal);
  return checkResult(model, options.questions, result);
}

const QUESTION_EXAMPLE = `  const { answers } = await reins.decisions.classify({
    state: { command: "git push --force origin master" },
    questions: {
      risky: { type: "bool", instructions: "Could the command lose work or reach production?",
        criteria: { true: "It could", false: "It cannot" } },
      area: { type: "choice", instructions: "What does it touch?",
        criteria: { git: "A git repository", files: "Local files", network: "Other machines" } },
      effort: { type: "score", instructions: "How hard is it to undo?",
        criteria: ["Trivial", "Some work", "Impossible"] },
    },
  });
  return answers.risky.probability > 0.5 ? answers.area.choice : "safe";`;

const list = sdkMethod({
  description:
    "List the decision models: models that answer typed questions about JSON state with probabilities, and do not chat. " +
    "Pi's catalog models whose provider is signed in (\"<provider>/<id>\"), then extensions' (\"<extension>__<model>\"). " +
    "input has \"image\" when a model judges images too.\n\n  return await reins.decisions.list();",
  params: [{ name: "options", schema: Type.Object({ signal: Type.Optional(SignalSchema) }), optional: true }],
  returns: Type.Array(DecisionModelSchema),
  tags: ["decisions", "decision", "classify", "classifier", "models", "judge", "triage", "route"],
  run: (context, options = {}) => listDecisionModels(context.models, signalOf(context, options.signal)),
});

const classifyMethod = sdkMethod({
  description:
    "Answer questions about state with a decision model (by default the one chosen in Settings): fast and cheap " +
    "judgements, such as routing, triage or an approval check. Each question is a choice (pick one of criteria's keys), " +
    "a bool (the probability of true) or a score (the expected level of criteria, from 0). The answers are checked " +
    "against the questions, whichever model answered.\n\n" + QUESTION_EXAMPLE,
  params: [{ name: "options", schema: ClassifyOptionsSchema }],
  returns: DecisionResultSchema,
  tags: ["decisions", "decision", "classify", "classifier", "judge", "triage", "route", "risk", "approve", "question"],
  run: (context, options) => classify(context, options),
});

export const DECISIONS = {
  namespace: "decisions",
  methods: { list, classify: classifyMethod },
  types: { DecisionModel: DecisionModelSchema, DecisionResult: DecisionResultSchema, DecisionQuestion: QuestionSchema, DecisionAnswer: AnswerSchema, DecisionUsage: UsageSchema },
} satisfies ScriptNamespace<CallContext>;
