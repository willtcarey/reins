# Image generation

Agents make and edit images with image models through `execute` scripts (`api.images`, [scripting.md](scripting.md)). Reins has no image models of its own: extensions give them. The built-in **OpenAI images** extension gives the models of OpenAI-compatible image APIs that you add in Settings (OpenAI, an SGLang server). Image models are not chat models: they are not in the model picker.

## Adding an endpoint

**Settings → Extensions → OpenAI images** lists your endpoints. **Add image endpoint** asks for:

- **Name**: lowercase letters, digits and hyphens (at most 32). It starts each of the endpoint's model IDs.
- **Base URL**: the API's base, with its version, for example `https://api.openai.com/v1` or `http://william-pc.otter-byzantine.ts.net:30010/v1`.
- **API key** (optional): sent as a bearer token. Reins keeps it encrypted and never shows it again; leave the field blank to keep the saved key. **Remove API key** in the endpoint's menu removes it.
- **Models** (optional): the model IDs to offer, one a line. Blank: every model the server lists (`GET /models`), asked each time an agent lists the models.
- **Default parameters** (optional): a JSON object added to each request, for example `{ "output_format": "png" }`. An agent's own parameters replace the same keys.
- **Random seed** (off by default): send a new random `seed` with each request that has none. SGLang uses the same seed each time otherwise, so the same prompt gives the same image. The result's text then says the seed (`Seed: 81723`), so an agent can make that image again by giving it in `parameters`. Leave it off for OpenAI, which does not accept a seed.

**Test** in the endpoint's menu asks the server for its models and shows them, or why it failed. **Edit** and **Remove** change or forget the endpoint.

The SGLang Qwen-Image server fails with HTTP 500 (`cannot write mode RGBA as JPEG`) unless the request asks for PNG: give its endpoint the default parameters `{ "output_format": "png" }`, and turn on **Random seed**.

## What agents do

The system prompt tells agents about `api.images`, and the `execute` tool's description tells them about `image()`:

```javascript
const { models } = await api.images.list();
const result = await api.images.generate("a red fox in snow, watercolor", { size: "1024x1024" });
image(result);       // the agent sees the image
return result.text;  // a revised prompt, when the model gave one
```

- **`api.images.list()`** gives `{ models, unavailable }`: each model's `id`, `name`, `description`, `provider` and `input` (`"image"` when it takes images to edit), and the providers whose list failed, with why. An OpenAI images model's ID is `openai-images__<endpoint>/<model>`, for example `openai-images__william-pc/Qwen-Image-2.1-Turbo`. An endpoint that cannot list its models is left out while another can.
- **`api.images.generate(prompt, options?)`** gives `{ model, images, text? }`. `options`: `model` (an ID from `list`; the first listed model by default), `images` (images to edit: image blocks, `{ data, mimeType }` or an earlier result), `size` (for example `"1024x1024"`), `count` (1 to 10) and `parameters` (the provider's own, given as they are). With no model at all, it says to add an image provider. A generation can take tens of seconds (a 1024×1024 Qwen-Image takes about 10 s).
- **The agent does not see an image until it gives it to `image()`.** It can also edit one: `api.images.generate("make the sky purple", { images: result })`.
- **The chat** shows the images under the script that gave them, without expanding it. Click one to open it full screen.

## OpenAI images requests

Without images, a generation is `POST <base>/images/generations` with JSON: the default parameters, the agent's parameters, then `model`, `prompt`, `n` (for `count`) and `size`. With images, it is `POST <base>/images/edits` as multipart, the images as `image` (one) or `image[]` (several). Reins sends no `response_format` (OpenAI's gpt-image models refuse it): it reads each image from `b64_json`, or fetches its `url`, resolved against the base URL (SGLang answers a path such as `/v1/images/<id>/content`). A server's error reaches the agent with its message, for example `william-pc: HTTP 500: cannot write mode RGBA as JPEG`. Every model is offered for edits; a server without `/images/edits` refuses them.

Developer docs: [server-sdk.md](../dev/server-sdk.md) *Images*.
