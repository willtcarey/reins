# Chat Composer Multimodal Attachments

Status: **completed** — implemented composer, attachment storage/API, multimodal prompt path, externalization, hydration, and attachment pruning.

Replace the chat textarea with a dedicated composer that supports image attachments while keeping normal chat/session payloads lightweight. The key design is content-addressed attachment storage: binary image bytes live in SQLite BLOB rows, while chat messages, WebSocket events, and REST history responses carry small attachment references.

## Goals

- Support image attachments from the composer via button, paste, and drag/drop.
- Preserve text-only prompt compatibility.
- Support images in all runtimes, including prompt images and image-producing tool results such as `read` on image files.
- Keep base64 image data off normal UI channels:
  - WebSocket events
  - `/api/sessions/:id/messages`
  - persisted `session_messages.message_json`
- Hydrate attachment refs to base64 only at the runtime/model boundary.
- Externalize inline base64 images from runtime/tool output before broadcasting or persisting.

## Core invariant

There are three representations of image content:

1. **Client / persisted representation** — attachment refs, no base64.
2. **Runtime representation** — inline base64, because pi and Claude SDK need model-ready image blocks.
3. **Composer draft representation** — browser `File` objects and object URLs before the prompt is sent.

Base64 should only exist at runtime/provider boundaries or in legacy rows not yet migrated.

## Content block API shapes

### Text block

```ts
interface TextContentBlock {
  type: "text";
  text: string;
}
```

### Client/persisted image ref block

Used in WebSocket commands/events, REST message responses, and `session_messages.message_json`.

```ts
interface ImageAttachmentBlock {
  type: "image";
  attachmentId: string;
  mimeType: string;
  filename?: string;
  byteSize: number;
  sha256?: string;
}
```

### Runtime inline image block

Used only after hydration for runtime calls, and as input to externalization when runtimes/tools emit images.

```ts
interface InlineImageBlock {
  type: "image";
  data: string; // base64, no data: URL prefix
  mimeType: string;
  filename?: string;
}
```

### Prompt content

The client-facing prompt API remains string-compatible:

```ts
type ClientPromptContent =
  | string
  | (TextContentBlock | ImageAttachmentBlock)[];
```

The runtime-facing prompt API is hydrated:

```ts
type RuntimePromptContent =
  | string
  | (TextContentBlock | InlineImageBlock)[];
```

For text-only sends, the app should still send a plain string.

## Attachment storage

Add a content-addressed table scoped to a session:

```sql
CREATE TABLE session_attachments (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  kind TEXT NOT NULL, -- initially "image"
  mime_type TEXT NOT NULL,
  filename TEXT,
  byte_size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  data BLOB,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  pruned_at TEXT,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  UNIQUE (session_id, sha256, mime_type)
);
```

Do **not** add a separate attachment-reference table for the first pass. Attachment refs are already present in `session_messages.message_json`; pruning can search message JSON during the pruning pass to determine whether an attachment is still referenced by unpruned messages.

Content addressing means repeated externalization of the same base64 image converges on the same attachment row. This avoids having to match streaming tool events to later persisted tool-result messages.

## REST APIs

### Upload composer attachments

```http
POST /api/sessions/:sessionId/attachments
Content-Type: multipart/form-data

files: File[]
```

Response:

```ts
interface AttachmentUploadResponse {
  attachments: AttachmentInfo[];
}

interface AttachmentInfo {
  id: string;
  kind: "image";
  mimeType: string;
  filename?: string;
  byteSize: number;
  sha256: string;
  url: string; // /api/sessions/:sessionId/attachments/:id
}
```

Validation:

- Session must exist.
- MIME type must be an allowed image type (`image/png`, `image/jpeg`, `image/webp`, optionally `image/gif`).
- Enforce per-image and per-prompt byte limits.
- Compute SHA-256 from decoded bytes and upsert by `(session_id, sha256, mime_type)`.

### Fetch attachment bytes

```http
GET /api/sessions/:sessionId/attachments/:attachmentId
```

Response:

- `200` with raw bytes and `Content-Type: image/...` when data is present.
- `404` if the attachment does not belong to the session.
- `410 Gone` if the attachment metadata remains but `data` has been pruned.

The frontend uses this endpoint for previews in user messages and tool results.

## WebSocket API

Widen the existing command fields rather than introducing a separate prompt channel.

```ts
type PromptCommand = {
  type: "prompt";
  sessionId: string;
  message: ClientPromptContent;
};

type SteerCommand = {
  type: "steer";
  sessionId: string;
  message: ClientPromptContent;
};
```

Text-only clients still send:

```json
{ "type": "prompt", "sessionId": "sess_1", "message": "hello" }
```

Multimodal sends use refs:

```json
{
  "type": "prompt",
  "sessionId": "sess_1",
  "message": [
    { "type": "text", "text": "What is wrong with this screenshot?" },
    {
      "type": "image",
      "attachmentId": "att_123",
      "mimeType": "image/png",
      "filename": "screen.png",
      "byteSize": 123456
    }
  ]
}
```

Synthetic user-message broadcasts should also be widened:

```ts
type UserMessageBroadcast = {
  type: "user_message";
  sessionId: string;
  projectId: number;
  message: ClientPromptContent;
};
```

## Frontend call flow

### Composer draft state

`<chat-composer>` owns draft attachments as browser objects:

```ts
interface DraftAttachment {
  id: string; // local-only id
  file: File;
  objectUrl: string;
  byteSize: number;
  mimeType: string;
  filename: string;
}
```

The composer adds draft attachments from:

- attach button file picker
- paste event `clipboardData.files`
- drag/drop `dataTransfer.files`

### Send flow

1. User clicks Send or presses Enter.
2. Composer trims text and checks draft images.
3. If there are no images, emit submit with plain string text.
4. If images exist:
   1. `POST /api/sessions/:sessionId/attachments` with the draft image files.
   2. Build `ClientPromptContent` from text plus returned attachment refs.
   3. Emit submit with that content.
5. `chat-panel` calls `store.prompt(content)` or `store.steer(content)`.
6. `ActiveSessionStore` calls `AppClient.prompt(sessionId, content)`.
7. `AppClient` sends the widened WS command.
8. `chat-panel` optimistically appends a user message with the same client content refs.

## Backend prompt call flow

In `ws.ts` for `prompt` / `steer`:

1. Validate `message` as `ClientPromptContent`.
2. Resolve the session/project/runtime.
3. Expand skill slash commands in text blocks only:
   - string prompt: same behavior as today
   - block prompt: prepend skill blocks to the first text block, preserving image refs
4. Hydrate image refs:
   - load each `attachmentId` BLOB scoped to the session
   - convert to `{ type: "image", data: base64, mimeType }`
5. Ack the command.
6. Broadcast the raw visible user message with attachment refs, not expanded skill content and not base64.
7. Call `runtime.prompt(runtimeContent)` or `runtime.steer(runtimeContent)`.

## Runtime adapter call flow

### Runtime interface

```ts
interface AgentRuntime {
  prompt(content: RuntimePromptContent): Promise<void>;
  steer(content: RuntimePromptContent): Promise<void>;
  // ...
}
```

### Pi runtime

Pi already supports images through `AgentSession.prompt(text, { images })` and `steer(text, images)`.

Adapter behavior:

1. Split `RuntimePromptContent` into text and image blocks.
2. For prompt: `session.prompt(text, { images })`.
3. For steer: `session.steer(text, images)`.

### Claude SDK runtime

Adapter behavior:

1. Convert text blocks to SDK text blocks.
2. Convert inline image blocks to SDK image blocks:

```ts
{
  type: "image",
  source: {
    type: "base64",
    media_type: block.mimeType,
    data: block.data,
  },
}
```

3. Enqueue the resulting SDK user message.

## Runtime event externalization

Runtime/tool output may contain inline base64 images. Before any event is broadcast to clients, run it through a sanitizer:

```ts
externalizeImages(sessionId, value): valueWithAttachmentRefs
```

The helper should:

1. Find `{ type: "image", data, mimeType }` blocks recursively in known event/message/result shapes.
2. Decode base64.
3. Compute SHA-256.
4. Upsert into `session_attachments`.
5. Replace the block with an `ImageAttachmentBlock`.

Use this in `attachRuntimeBroadcastObserver()` before sending WebSocket events. This covers live `read` image results and prevents base64 in streaming payloads.

## Persistence flow

`appendMessages(sessionId, messages)` should externalize before inserting:

1. For each runtime message, call `externalizeImages(sessionId, msg)`.
2. Insert sanitized JSON into `session_messages`.

`persistMessages()` can continue to delegate to `appendMessages()`, so turn-end / agent-end snapshots get the same behavior.

Because attachments are content-addressed, images already externalized for streaming broadcasts will be reused when the same image appears later in runtime snapshots.

## Loading messages

### Client history

`GET /api/sessions/:sessionId/messages` should return client/persisted blocks with attachment refs only.

If legacy rows contain inline base64 image blocks, the server should either:

- lazily externalize and rewrite those rows before returning, or
- run a migration that externalizes existing inline image blocks.

Do not return base64 in the normal messages response.

### Runtime history / resume

`loadMessagesForLLM(sessionId)` should hydrate attachment refs:

1. Load persisted messages from `session_messages`.
2. For each `ImageAttachmentBlock`, load the BLOB.
3. Replace it with `InlineImageBlock`.
4. Return runtime-ready messages.

If an attachment was pruned, replace the image with a text placeholder such as:

```ts
{ type: "text", text: "[Image attachment pruned]" }
```

## Pruning

Existing compaction pruning replaces old tool-result content with `[pruned]`. Extend that path to handle attachments:

1. Before pruning old tool-result rows, collect attachment refs from those rows.
2. Replace the tool-result message JSON as today.
3. Search remaining unpruned `session_messages.message_json` rows for those attachment ids.
4. For refs that no remaining unpruned message uses, clear BLOB data and set `pruned_at`.
5. Keep metadata (`id`, `mime_type`, `byte_size`, `sha256`, `pruned_at`) for audit/display.

This avoids maintaining a second reference index. Pruning is infrequent enough that scanning message JSON during the pruning pass is acceptable.

## UI rendering

Tool renderers and user-message rendering should accept both image block forms for transitional compatibility:

```ts
function imageSrc(sessionId: string, block: InlineImageBlock | ImageAttachmentBlock): string {
  if ("attachmentId" in block) return `/api/sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(block.attachmentId)}`;
  return `data:${block.mimeType};base64,${block.data}`;
}
```

Once legacy inline data is migrated, the normal path should always be attachment URLs.

## Implementation order

Implement in phases so the UI refactor lands before the multimodal storage/runtime changes.

### Phase 1 — text-only composer replacement

1. Build `<chat-composer>` as a text-only replacement for the current inline textarea.
2. Move autosizing, Enter-to-send, Stop, focus handling, and skill suggestion wiring into the composer.
3. Keep the public submit shape as a plain string for this phase.
4. Wire `chat-panel` to the composer and preserve existing text-only prompt/steer behavior.
5. Remove the global `field-sizing` textarea autosize dependency once JS autosize is in place.

### Phase 2 — attachment storage and APIs

1. Add backend content/attachment types and the `session_attachments` DB migration.
2. Add attachment model helpers:
   - upload/store files
   - externalize inline images
   - hydrate refs for runtime
   - collect attachment ids from message JSON for pruning
3. Add REST attachment upload/fetch routes.

### Phase 3 — multimodal prompt path

1. Widen frontend/backend prompt and user-message WS types from string-only to `ClientPromptContent`.
2. Update `ws.ts` prompt/steer flow to expand text, hydrate refs, and broadcast refs.
3. Update runtime interface and pi/Claude adapters for `RuntimePromptContent`.
4. Update `<chat-composer>` to collect image files, upload them, and submit attachment refs.
5. Update user-message rendering to show attached image refs via the attachment endpoint.

### Phase 4 — runtime/tool output externalization

1. Externalize runtime events in the broadcast observer before WebSocket broadcast.
2. Externalize persisted messages in `appendMessages()` and hydrate in `loadMessagesForLLM()`.
3. Update tool renderers to use attachment URLs.

### Phase 5 — pruning

1. Add pruning support for attachment BLOBs by scanning remaining message JSON for attachment refs.

## Tests to add

- Text-only `<chat-composer>` preserves Enter-to-send, Shift+Enter newline, Stop, autosize, and skill suggestion behavior.
- Attachment upload validates MIME/size and dedupes by SHA.
- Attachment fetch is session-scoped and returns raw bytes.
- WS prompt accepts a string unchanged.
- WS prompt accepts attachment refs, hydrates before runtime call, and broadcasts refs only.
- Skill expansion modifies text blocks without disturbing image refs.
- Runtime broadcast observer externalizes inline image tool results before broadcasting.
- `appendMessages()` stores refs instead of base64.
- `loadMessagesForLLM()` hydrates refs back to inline base64.
- `/messages` never returns base64 for image refs.
- Pruning clears attachment BLOB data when no unpruned messages reference it.
