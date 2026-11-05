# Images

Agents can make and edit images in `execute` scripts with `api.images`. The models come from extensions. The built-in one, **openai-images**, gives the models of OpenAI-compatible image APIs (OpenAI, or an SGLang server such as the Qwen-Image server on william-pc).

## Configure endpoints

There is no Settings page. Write the endpoints to `<data dir>/extensions/openai-images/endpoints.json` (the data dir is `.reins/` in a dev checkout). Reins reads the file at each call, so a change takes effect at once:

```json
[
  {
    "name": "william-pc",
    "baseUrl": "http://william-pc.otter-byzantine.ts.net:30010/v1",
    "parameters": { "output_format": "png" },
    "randomSeed": true
  },
  { "name": "openai", "baseUrl": "https://api.openai.com/v1", "apiKey": "sk-…", "models": ["gpt-image-1"] }
]
```

- **`name`**: lowercase letters, digits and hyphens. It is part of the model IDs.
- **`baseUrl`**: the API's base URL, with its version.
- **`apiKey`** (optional): sent as a bearer token. It is kept in the file as plain text.
- **`models`** (optional): the models to offer. Without it, Reins offers every model of `GET <baseUrl>/models`.
- **`parameters`** (optional): added to each request. The request's own parameters replace them.
- **`randomSeed`** (optional): sends a random `seed` with each request that has none. SGLang uses a fixed seed otherwise, so the same prompt always gives the same image. Do not use it for OpenAI, which refuses `seed`.

The SGLang Qwen-Image server fails with HTTP 500 (`cannot write mode RGBA as JPEG`) unless the request asks for PNG: give it `"parameters": { "output_format": "png" }`.

## What agents do

```javascript
const models = await api.images.list();   // ["openai-images__william-pc/Qwen-Image-2.1-Turbo", …]
const result = await api.images.generate("a red fox in snow, watercolor", { size: "1024x1024" });
image(result);                            // the agent sees the image
```

- **`api.images.list()`** gives the model IDs, `<extension>__<model>`. An openai-images model is `openai-images__<endpoint>/<model>`.
- **`api.images.generate(prompt, options?)`** gives `{ model, images }`. `options`: `model` (the first listed model by default), `images` (images to edit: anything `image()` takes, such as an earlier result), `size`, `count` and `parameters` (the provider's own, for example `{ seed: 7 }`).
- **The agent does not see an image until it gives it to `image()`.**
- **The chat** shows the images under the script. Click one to open it full screen.

Without images, a request is `POST <baseUrl>/images/generations` (JSON). With images, it is `POST <baseUrl>/images/edits` (multipart). A server's error reaches the agent, for example `william-pc: HTTP 500: …`.

Developer docs: [server-sdk.md](../dev/server-sdk.md) *Images*.
