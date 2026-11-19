# Decisions

A **decision model** (a classifier model) answers typed questions about some JSON state. It does not chat and does not write text: it gives each answer with probabilities, quickly and at low cost. Use one for small judgements that do not need a full agent: "is this command risky?", "which agent gets this task?", "is this Inbox item easy?".

Agents use them in `execute` scripts, and extensions use them through the server SDK, with `reins.decisions`. Reins gets the models from:

- **Pi's catalog**: the classifier models of each provider you are signed in to, for example `openrouter/~liquid/d1-latest`, `openrouter/cloudflare/clef-flash`, `github-copilot/microsoft-decision-1`, `openai/gpt-6-luna` (an OpenAI API key, not a ChatGPT sign-in) and Cloudflare's Clef (*Cloudflare's Clef* below).
- **Extensions** that register a decisions provider (*Providers from extensions* below).

## The questions

One call asks one or more questions about one `state`. Each question has `instructions` (the question) and `criteria`:

| Type | `criteria` | Answer |
|---|---|---|
| `choice` | each choice's key, with what it means: `{ coder: "Code changes", writer: "Docs" }` (two or more) | `{ type: "choice", choice, probabilities, confidence }`: `choice` is one of the keys, `probabilities` gives each key a number from 0 to 1 |
| `bool` | `{ true: "…", false: "…" }` | `{ type: "bool", probability }`: the probability of `true` |
| `score` | each level, lowest first: `["Minutes", "Hours", "Days"]` (two or more) | `{ type: "score", score, confidence }`: the expected level, from 0 to `criteria.length - 1` |

Reins checks the answers against the questions, whichever model answered: each question has an answer of its type, a choice is one of its keys, and the numbers are in range. A model that answers otherwise makes the call throw (`<model> gave malformed answers: …`), so code can use the answers as they are.

## What agents do

```javascript
const { model, answers, usage } = await reins.decisions.classify({
  state: { command: "git push --force origin master", branch: "master" },
  questions: {
    risky: { type: "bool", instructions: "Could the command lose work or reach production?",
      criteria: { true: "It could", false: "It cannot" } },
    area: { type: "choice", instructions: "What does it touch?",
      criteria: { git: "A git repository", files: "Local files", network: "Other machines" } },
    undo: { type: "score", instructions: "How hard is it to undo?",
      criteria: ["Trivial", "Some work", "Impossible"] },
  },
});
if (answers.risky.probability > 0.5) return `Ask first: ${answers.area.choice}, undo level ${answers.undo.score.toFixed(1)}`;
```

- **`reins.decisions.list()`** gives the models as `{ id, name, input }`. `input` has `"image"` when the model also judges images.
- **`reins.decisions.classify({ model?, state, images?, questions, temperature? })`** gives `{ model, answers, usage? }`. `usage` is `{ input, output, cost }` (tokens, and USD at the catalog's price) when the service reports it.
  - **`model`**: an ID from `list()`. Without it, the default decision model (*The default model* below).
  - **`state`**: a JSON object. Put in it all that the model must judge.
  - **`images`**: images judged with the state, for a model that takes them. It takes what `image()` takes, such as an earlier `reins.images.generate` result.
  - **`temperature`**: above 1 softens the probabilities, below 1 sharpens them. It does not change which answer is likeliest. Not every model applies it.
- A model's error (a bad key, a refused request) throws with the provider's message. The script's end, or an extension's `signal`, stops a call.
- To judge several items, call `classify` once per item (`Promise.all`).

Model IDs:

- **Pi's catalog**: `<provider>/<id>`, as Reins names models elsewhere (`openrouter/~liquid/d1-latest`, `cloudflare-workers-ai/@cf/cloudflare/clef-flash`).
- **Extensions**: `<extension>__<model>`, as image models and tools are (`clef__clef-flash`).

## Cloudflare's Clef

Pi's catalog has Cloudflare's decision models on Workers AI: `cloudflare-workers-ai/@cf/cloudflare/clef-flash`, `…/clef-omni` and `…/clef` (and TypeSafe's `…/typesafe/jev`). They take images. Workers AI's free allocation is 10,000 Neurons a day (reset at 00:00 UTC), which is about 2.9 M input tokens of Clef Flash, 0.73 M of Clef Omni or 0.46 M of Clef. More needs the Workers Paid plan.

1. In the Cloudflare dashboard, make an API token with the *Workers AI* template (My Profile → API Tokens).
2. Store it under **Settings → Models → Providers** for **cloudflare-workers-ai**.
3. Give the server your account ID: `CLOUDFLARE_ACCOUNT_ID=<id>` in its environment (for a checkout, in `.env`, which Bun reads at start), and restart it. Reins' credential store keeps the key only, not the account ID.

A call's `usage.cost` is USD at Cloudflare's price; Neurons are `cost / 0.011 × 1000`.

## The default model

**Settings → Models → Decision model** chooses the model a call without `model` uses, from the models `list()` gives. Until one is chosen, such a call throws: *No decision model: give one (reins.decisions.list()), or choose a default in Settings → Models → Decision model*. A chosen model that is no longer listed (a provider signed out, an extension turned off) stays chosen and is shown as unavailable.

## Providers from extensions

An extension can give decision models of its own, such as a local model on llama.cpp or Ollama: it registers a provider with `reins.decisions.registerProvider({ list, classify })`, one per extension. Its models are listed after Pi's, as `<extension>__<model>`, and go away when the extension is reloaded or turned off. See [building-extensions.md](building-extensions.md) *Writing a decisions provider*.

Developer docs: [server-sdk.md](../dev/server-sdk.md) *Decisions*.
