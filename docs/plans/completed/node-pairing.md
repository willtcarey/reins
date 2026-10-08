# Node Pairing and Authentication

Status: **done** (2026-10-08). Decisions: [ADR-023](../../adr/023-node-pairing-and-challenge-authentication.md); current design: [node-contract.md](../../dev/node-contract.md) *Pairing and authentication*, [node-transport.md](../../dev/node-transport.md) *Details: authentication*. The "Pairing and node authentication" item of [node-architecture.md](../node-architecture.md) (see its *Trust model*, *Pairing from the settings page* and *Connection*). Out of scope: the WebSocket `/node-link` transport, the install script, bundle delivery, node-owned sources, a background service, Windows.

## Data (migration `050_node_pairing`, append-only)

- `nodes` gains `public_key` (base64url of the raw 32-byte Ed25519 key; NULL for a node that was never paired, i.e. the seeded local node), `hostname`, `paired_at`, `revoked_at` (ISO UTC strings, ADR-004). A unique partial index on `public_key`.
- `node_pairing_grants (id, code_sha256 UNIQUE, name, created_at, expires_at, consumed_at, node_id)`: only the SHA-256 (hex) of the code is stored. Timestamps are computed in JS (`toISOString()`), never `datetime('now')`, so tests control time.

## Pairing (server)

- `POST /api/nodes/pairing-codes {name?}` → 201 `{code, expiresAt}`. The code is 32 random bytes, base64url (43 chars), valid 10 minutes, single use. Shown once; never logged.
- `POST /api/nodes/pair {code, publicKey, hostname}` → 201 `{nodeId, name}`. One conditional `UPDATE … SET consumed_at WHERE code_sha256 = ? AND consumed_at IS NULL AND expires_at > ?` inside the transaction that inserts the `nodes` row (ID `crypto.randomUUID()`, name = grant name, else hostname), so concurrent redemptions have one winner. Unknown, expired and used codes all answer 403 "Invalid or expired pairing code" (one message: no oracle). A malformed body or public key is 400 and consumes nothing. Error messages never contain the code.
- `POST /api/nodes/:nodeId/revoke` → 200 the node view: sets `revoked_at` and closes the node's link (`state.nodes.disconnect`). 404 unknown; 409 for a node that was never paired (the local node is authorized by the socket's file permissions and cannot be revoked). Revoking again is a no-op.
- `GET /api/nodes` → `NodeView`: `{id, name, connected, paired, hostname, pairedAt, revokedAt}`.
- A revoked node is refused at `node.hello` on every transport ("Node revoked: <id>").

## Challenge (link)

`node.authenticate` is a server→node JSON-RPC request sent by the server as soon as an authenticating connection opens, before `node.hello`:

- params `{challengeId (uuid), nonce (32 random bytes, base64url)}`, result `{nodeId, signature}` (base64url Ed25519 signature). Parsed tolerantly (`z.object`): bootstrap surface, additive changes only.
- Signed bytes: UTF-8 of `JSON.stringify(["reins-node-auth-v1", origin, nodeId, challengeId, nonce])`. `origin` is the server origin the node dialed (`new URL(serverUrl).origin`); the server checks it against the origin its transport gives the connection.
- Server: one challenge per connection, consumed by the first answer whatever the outcome. It verifies the signature against the node's stored public key, refusing an unknown, unpaired or revoked node, and binds the node ID to the connection; a failure closes the connection. The hello handler waits for authentication and refuses a hello whose `nodeId` differs from the bound one. The transport takes the key lookup injected (`authenticate: {origin, publicKey(nodeId)}`); it imports no stores.
- Which connections authenticate is the transport's choice, through the hub: `state.nodes.accept(socket, {…linkOptions, authenticate: {origin}})`. The local Unix socket passes none: its file permissions remain its authentication, and it accepts any known, unrevoked node ID as before. The future WebSocket route passes the origin.
- Node: `createNodeConnection(socket, {…, identity: {nodeId, origin, privateKey}})` waits for `node.authenticate`, answers it and only then sends `node.hello`. Without `identity` it says hello at once, as today.
- No protocol version bump: the local link is unchanged and the challenge precedes the negotiation. The new exports in `@reins/node-protocol` need a restart of `bun run dev` (the server keeps the protocol package it started with).

## CLI (`packages/node`)

`reins node pair <server URL> <code> [--force]`, run from source as `bun run reins node pair …` until the bundle exists.

- Home: `REINS_NODE_DATA_DIR`, default `~/.reins` (created 0700). Config `<home>/node.json`: `{version: 1, serverUrl, nodeId, keyPath, sourceRoots: []}`. Key `<home>/keys/<nodeId>.pem` (PKCS#8 PEM, 0600).
- Generates the keypair in memory, redeems the code (through `@reins/client`, ADR-022) with its public key and `os.hostname()`, then writes the key, then the config (temp file + rename: the config is the commit point, so a failure never leaves a config pointing at a missing or wrong key). An existing config refuses the run before anything is sent (the code stays unused) unless `--force`; with `--force` the previous key file is removed once the new config is in place.
- Exit codes: 0 paired, 1 unexpected failure, 2 usage, 3 already paired (no `--force`), 4 code refused (403), 5 server unreachable or unexpected response. The last line of output says what happened.

## Settings → Nodes

A section of the settings panel: every node with its connection status (connected, offline, revoked) and hostname; **Add node** (optional name) shows the code and the command once, saying it is single-use and expires in 10 minutes; **Revoke** on a paired node, with confirmation.

## Tests

Stolen (a code read from the database, i.e. its hash, does not redeem; a code redeemed once does not redeem again or rebind the key), expired and competing codes; challenge replay (an answer recorded on one connection fails on the next); a wrong node ID in the hello; reconnect fencing (a second authenticated connection replaces the first, whose epoch is then refused); revocation (link closed, the key refused on later connections); CLI re-run safety and exit codes.

## Seams left for later items

- The WebSocket route supplies `authenticate.origin`. Behind a proxy (e.g. `tailscale serve`) the request URL may not be the URL the node dialed; that item decides between a configured public URL and forwarded headers.
- `reins node start` reads `node.json` and the key (`readNodeConfig`, `loadNodeIdentity`) and dials with `identity`.
- A revoked node is refused at its challenge (the connection closes; only the server logs why) and at hello with a definite message; a remote dialer should get a refusal it can recognise and stop redialing instead of backing off forever.
- The challenge is the connection's first frame: the WebSocket route must call `accept` from `open`.
