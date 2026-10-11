# The node bundle

A remote node runs Reins from one file, `reins.js`: the `reins` command and all of the node (`packages/cli`, `packages/node`, `@reins/node-protocol`, `@reins/client`, Pi and their dependencies), built by the server from its own checkout (`bun build --target bun`). Bun is the only other thing the machine needs. The **build ID** is the sha256 of the file, and the file also holds `docs/features`, so one ID names the code and the docs a node runs. Why the server delivers the node's code is in [ADR-025](../adr/025-node-version-handshake.md) and [completed/remote-nodes.md](../plans/completed/remote-nodes.md) *Decisions*. This doc covers the bundle (what is in it, how it is built and what it does when it starts), how the server serves it, how a machine installs and runs it (the node home, the launcher and `reins node setup`) and how an installed node updates itself. User-facing: [nodes.md](../features/nodes.md).

## Building it

`buildNodeBundle({testHooks?})` (`packages/backend/src/node-bundle/build.ts`) → `{bytes, buildId}`. It runs the build (`bundler.ts`) in a `bun` process of its own: Bun 1.3.9 can fail to read, for a build, files the building process has already loaded (Pi, which the server loads too; "Unexpected reading file", seen after `bun test` moves to another test file), and the build's memory goes with the process. About 200 ms; 12.3 MB, 2.4 MB gzipped.

- **Entry:** `packages/cli/src/bundle/entry.ts`, read by path. The server never imports the CLI or the node (`reins/cli-import-boundary`, `reins/node-import-boundary`); a `Bun.build` entrypoint is not an import.
- **Not minified.** Minified it is 7.2 MB against 12.3 MB but 1.9 MB gzipped against 2.4 MB, and starts about 20 ms faster (0.21 s against 0.24 s for `reins help`); unminified, a node's stack traces name real functions and lines in a readable file. Minifying whitespace and syntax only (9.3 MB, 2.1 MB gzipped) gains as little.
- **Docs:** every file under `docs/features`, sorted by path, replaces `packages/cli/src/bundle/embedded-docs.ts` (a build plugin). From source that module throws: only the bundle runs the entry.
- **Photon stub:** `@silvia-odwyer/photon-node` (Pi's image resizing) is replaced by a module that throws. Bun writes CommonJS `__dirname` as the build machine's absolute path, so the bundle would read photon's WASM from the build checkout, and its bytes would depend on where the checkout is. The node never resizes images, and Pi treats a photon that fails to load as no resizing.
- **Test hooks:** the build defines `REINS_TEST_HOOKS` (`false`, or `true` with `testHooks`). `runNodeProcess` (`packages/node/src/node-process.ts`) reads `REINS_NODE_TEST_FAUX_PROVIDER` and imports the faux provider only under `typeof REINS_TEST_HOOKS === "undefined" || REINS_TEST_HOOKS`, so a production bundle holds neither the variable's name nor the faux provider's code, while from source (where the name is undefined) the hook works as before. The condition must test the defined name itself: Bun eliminates `if (false)`, not a variable holding false.
- **`process.env.NODE_ENV` is defined `"production"`**: otherwise Bun writes the building process's `NODE_ENV` into the bundle in places, and the bytes would depend on it.
- **Deterministic:** the same sources build the same bytes, wherever the checkout is and whatever the builder's environment: module comments are paths relative to the repository root (`root`), the docs are sorted, and the guards below refuse an absolute path. Checked once by building from a copy of the checkout at another path (same ID); the test builds twice under different `NODE_ENV`s.
- **Guards** (`shippingProblems`): the build fails if the bundle contains the repository root or the build machine's home directory (`<home>/`), or imports, unbundled, anything that is neither a runtime built-in (`isBuiltin`: `fs`, `bun:sqlite`, …) nor provided by Bun (`ws`, `undici`, `node-fetch`). Under `--no-install` such an import fails to load; without it Bun fetches it from npm. Today the externals are built-ins plus those three.

`pi-coding-agent` exports only its root, so its TUI, jiti and babel come along; that is most of the size.

## Running it

`bun --no-install <dir>/reins.js <command> …`, from any directory, with no `node_modules`: `--no-install` makes a missing module fail instead of being fetched. Any `reins` command works (`node pair`, `node run`, `source add`, …). The entry (`packages/cli/src/bundle/entry.ts`), before anything of Pi is evaluated:

1. Sets, where the launcher has not (an empty value counts as unset; `applyBundleEnv`, with the node's install in `packages/node/src/install.ts`, which the entry imports first: it loads none of Pi):
   - `PI_PACKAGE_DIR=<dir>`. Pi reads `package.json` in its package directory as its modules load (`config.js`: its app name, config directory and version), and without this it walks up from the bundle and adopts the nearest one, whose `piConfig` would move Pi's agent directory. `<dir>` has none, so Pi uses its defaults; its `VERSION` reads `0.0.0`, which only Pi's CLI and self-update use. This is why the entry imports the rest of the code dynamically, after setting it.
   - `PI_OFFLINE=1`, so Pi never installs a package its `settings.json` lists.
   - `REINS_DOCS_DIR=<dir>/docs`, where the node's environment prompt names the REINS docs (node-runtime.md *Assembly*).
2. Writes the docs it carries to `<dir>/docs/features/` unless `<dir>/docs` exists (`unpackDocs`, `packages/cli/src/bundle/docs.ts`): into a temporary directory beside it, renamed into place, so no one sees half of them; of runs racing to unpack, one wins and the others leave its docs alone. A failure (a read-only directory) is printed and the command runs anyway.
3. Registers the Pi modules a bundle cannot load lazily (`registerBundledPiModules`, `@reins/node/bundled-pi`): Pi's OAuth flows (`registerBunOAuthFlows`, `@earendil-works/pi-ai/bun-oauth`) and its Bedrock provider (`setBedrockProviderModule` from `@earendil-works/pi-ai/compat` with `bedrockProviderModule` from `@earendil-works/pi-ai/bedrock-provider`). Pi otherwise loads them through computed `import()` paths, which a bundle cannot follow: every request on a stored OAuth credential would fail (`Cannot find module './anthropic.js'`). This is what Pi's own Bun binary does (`pi-coding-agent/dist/bun/runtime-setup.js`). The node run from source keeps loading them lazily.
4. Runs the command line (`runCli`, `packages/cli/src/cli.ts`) and exits with its code, telling it what this process is (`CommandContext.bundle`, a `RunningBundle` from `runningBundle`): the bundle's path, its build ID (its sha256, hashed here once, streamed) and whether a launcher runs it again (`restartable`: `REINS_NODE_RESTART_EXIT_CODE` is the launcher's code). Commands ask nothing else about what they run as.

## Serving it

Each handler load starts building the bundle when it starts (`start` in `server.ts`: `buildNodeBundle`, production; with the node's test hooks only under `REINS_NODE_BUNDLE_TEST_HOOKS=1`, a **test-only** variable the process tests set, like `REINS_NODE_TEST_FAUX_PROVIDER`; never set it in production) and keeps the result in memory with its build ID. The build runs in the background: the load serves at once, and a failed build is logged (once) without failing the load. In dev every handler reload builds it again. The Bun version a build needs is the server's own (`Bun.version`).

`serveNodeBundle` (`packages/backend/src/node-bundle/delivery.ts`, `state.nodeBundle`) answers the `/nodes/*` routes on the HTTP server, outside `/api` (`routes/nodes.ts`; nothing under `/nodes/` falls through to the web app):

| Route | Answer |
|---|---|
| `GET /nodes/install` | The install script (`node-bundle/install.sh`, `text/plain`), with its four values filled in, each quoted for sh: the server URL the request reached (`requestOrigin` in `nodes/node-link.ts`, the origin the node link checks: forwarded headers, else the request; ADR-024), the build ID, the bundle's sha256 and the Bun version. So the script parses no JSON. It holds no secrets. |
| `GET /nodes/manifest` | `{buildId, sha256, bunVersion, size}` (`NodeBundleManifest`). |
| `GET /nodes/builds/<buildId>/reins.js` | The bundle, for the current build ID (`immutable`); 404 for any other. |

Any other path or method under `/nodes/` is 404 (`handler.ts`). While the build runs, a request waits for it; after a failed build the manifest and bundle answer 503 until the next load. `/nodes/install` always answers 200 with a script, because `curl -fsSL … | sh` hides an HTTP error from sh (sh gets an empty script and exits 0): without a bundle, a failed build or one not done within `INSTALL_BUILD_WAIT_MS` (30 s), it is a script that prints one line in the install script's form (`Reins node install failed: the server could not build the node; see its log`, or `… the server is still building the node; try again in a minute`) and exits 1.

The node hub asks the same delivery which build nodes should run (`build(waitMs)`: the manifest, null after a failed build, or `"building"`), to answer a node bundle's hello (*Updates*).

**Bootstrap surface:** the manifest, the bundle download, the install script's URL and arguments, the node home's layout and the launcher (and its restart code) are read by nodes installed by older releases, so they change only additively; with the hello envelope and its reply ([ADR-025](../adr/025-node-version-handshake.md)).

## The install script

`curl -fsSL <server>/nodes/install | sh -s -- <code>` (POSIX sh, `set -eu`; it needs `curl`, `uname`, `sha256sum` or `shasum`, and `unzip` only to fetch Bun). Each failure is one line, `Reins node install failed: <what>`, and exit 1. It:

1. Makes the node home, `REINS_NODE_DATA_DIR` or `~/.reins` (0700 when it creates it).
2. Unless `<home>/bun --version` is the pinned version, downloads Bun's official release (`https://github.com/oven-sh/bun/releases/download/bun-v<version>/bun-<target>.zip`) into a temporary directory in the home, unpacks it and renames it to `<home>/bun`. The target: `linux` or `darwin`, `x64` or `aarch64` (a shell under Rosetta gets the native `aarch64`), `-musl` on a Linux whose loader is musl's (`/lib/ld-musl-*`), and `-baseline` on an x64 CPU without AVX2 (`/proc/cpuinfo`, `machdep.cpu.leaf7_features`), as Bun's own installer chooses: the default x64 build needs AVX2.
3. Unless `<home>/builds/<buildId>/reins.js` is there with the right sha256, downloads it (to `reins.js.<pid>` beside it), checks the sha256 and renames it into place; a mismatch removes the download and fails.
4. Execs `<home>/bun --no-install <home>/builds/<buildId>/reins.js node setup <server URL> <its own arguments>` with `REINS_NODE_DATA_DIR` set to the home. All further logic is in the bundle, where it is tested.

The code is an argument, never in a URL, and the script prints it nowhere.

## The node home

What an installed node keeps in its home (`REINS_NODE_DATA_DIR`, default `~/.reins`):

```
~/.reins/
  bun                      the pinned Bun (the install script's)
  builds/<buildId>/        reins.js and the docs/features it unpacks beside itself
  current -> builds/<id>   the build the launcher runs (relative symlink)
  bin/reins                the launcher
  node.json, keys/         the pairing (node-contract.md *Pairing and authentication*)
  logs/node.log            the detached node's stdout and stderr, appended
  run/node-status.json     the running node's pid and state (node-contract.md *Process model*)
  run/launcher.json        the launcher `reins node start` ran: its pid and start time
  partial-writes/          unfinished fs.writes (the node's)
```

One module owns all of it but `bun`'s first install and `partial-writes/`: `NodeInstall` (`@reins/node/install`, `packages/node/src/install.ts`, `NodeInstall.of(env)`), this machine's installed node as a whole. It is the node package's, not the CLI's: the running node needs it (its status file, installing updates), and the node package never imports the CLI. Its pairing (`pairing`, `key`, `savePairing`), its builds (`installBuild`, `installUpdate`, `currentBuild`, `installed`, `command`: the launcher once installed, else `reins`, for hints) and its node in the background (`status`, `start`, `stop`, and `recorder` for the status file the running node writes; node-contract.md *Process model*). Running it is `runInstalledNode` (`packages/node/src/node-process.ts`): it reads the pairing and key, claims the status file, links the node to the paired server (`connectNode` over `webSocketTransport`), records the link's state and, run from a bundle, installs the updates it is told to. The layout, the launcher script, the pid checks and Bun's release target are private to it (with `install/bun.ts` and `install/process.ts`, which nothing else imports). The CLI's commands parse their arguments, call it (or `runInstalledNode`) and print the outcome (`report` in `packages/cli/src/node/outcome.ts`: every last line and exit code of `run`, `start`, `setup`, `stop` and `status`).

**`reins node setup <server URL> <code>`** (`packages/cli/src/node/setup.ts`) is the bundle's own install step, run by the install script from the build it downloaded; node-contract.md *Pairing and authentication* has what it does and its exit codes. It installs its build (`installBuild`, with the `RunningBundle` the entry gave it): if its `reins.js` is not already `builds/<buildId>/reins.js` (or that file does not hold it) it is copied there (temp file and rename), `current` is flipped to it atomically (a symlink made under a temporary name, renamed over `current`) and the launcher is written. From source (no bundle) setup refuses.

**The launcher**, `bin/reins` (written by `installBuild`), is a few lines of sh with the home written in: it exports `REINS_NODE_DATA_DIR` and `REINS_NODE_RESTART_EXIT_CODE` (75, so a node knows something restarts it) and runs `"$REINS_NODE_DATA_DIR/bun" --no-install "$REINS_NODE_DATA_DIR/current/reins.js" "$@"`, again whenever that exits with `RESTART_EXIT_CODE` (75, like the supervisor's reload code), so a node that flips `current` and exits with it runs on the new build; any other exit code is the launcher's. It is the same file for the same home, so writing it again changes nothing. It does not set Pi's variables or `REINS_DOCS_DIR`: the bundle's entry does, from the directory it runs from (Bun resolves `current` to the build's real path), and a node started in the background is given an environment without the `PI_PACKAGE_DIR` and `REINS_DOCS_DIR` of the bundle that started it (`withoutBundleEnv`, beside `applyBundleEnv` in `install.ts`, so the two lists are one).

## Updates

An installed node runs the server's build: its hello announces its build ID, and a server on another build answers `update {buildId, sha256, bunVersion}` instead of serving it ([ADR-025](../adr/025-node-version-handshake.md); the server's rule is in node-transport.md *Details: builds and updates*, the node's lifecycle in node-contract.md *Process model*). `reins node run` then installs it (`NodeInstall.installUpdate`), in this order, so that any failure leaves the home running what it ran:

1. The bundle, unless `builds/<buildId>/reins.js` already has the right sha256: `GET <server>/nodes/builds/<buildId>/reins.js` from the server in `node.json` (5 min bound), streamed to a temporary file beside it while it is hashed, checked against `sha256` (which must be the build ID) and renamed into place. Nothing in an update reads the whole bundle at once or waits on a process synchronously: the node keeps its link alive meanwhile.
2. **Bun**, when `bunVersion` is not the Bun the node runs (`Bun.version`): Bun's official release, `https://github.com/oven-sh/bun/releases/download/bun-v<version>/bun-<target>.zip`, downloaded into a temporary directory in the home, unpacked with `unzip`, checked to answer `--version` with that version, and renamed over `<home>/bun`. The target is `bunTarget(await thisMachine())` (`packages/node/src/install/bun.ts`), the install script's choice in JS (the one place for it there): `linux`/`darwin`, `x64`/`aarch64` (native under Rosetta), `-musl`, `-baseline` without AVX2. The running node's Bun keeps running from the replaced file; the restarted one runs the new.
3. `installBuild` (flips `current` and writes the launcher, the same file for the same home).

Then it exits with the restart code and the launcher starts the new build. A failure is logged and retried by asking the server again after a backoff (5 s doubling to 5 min), so a node follows the server even if it moved on meanwhile. Old builds stay in `builds/` (not pruned yet). The bundle needs `unzip` only to change Bun, as the install script does.

## Tests

- `packages/backend/src/__tests__/node-bundle/build.test.ts`: the build ID, determinism, test hooks in and out, Pi's OAuth flows compiled in, the guards.
- `packages/cli/src/bundle/docs.test.ts`: unpacking the docs.
- `packages/backend/src/__tests__/node-bundle.process-test.ts` (`bun run test:process`): builds a bundle with test hooks into a temporary directory outside the repository and, there, pairs it with a server process from this checkout and runs the node over the WebSocket; a project is created on it, and a session completes a turn with a `bash` call, the docs are beside the bundle and the session's environment prompt names them.
- `packages/backend/src/__tests__/node-bundle/delivery.test.ts`: the routes (manifest, bundle 404, waiting for the build, 503 after a failed one, an install script that fails saying why without a bundle, the install script's values from a forwarded origin, no web app under `/nodes/`), and the install script run with `sh` against them: the bundle put under its build ID and run as `node setup`, a download that fails its checksum refused, a missing code.
- `packages/node/src/install.test.ts`: `NodeInstall` against a temporary home, through its methods (a state it did not write, such as the install script's Bun or a newer release's `node.json`, through a named fixture): the pairing, installing builds (checked by running the launcher), the launcher's restart loop and the restart code it exports, `runningBundle`, and installing an update (the download, its checksum, a new Bun from an injected fetch and unpack, failures leaving the home as it was). `install/bun.test.ts`: `bunTarget`. `packages/cli/src/node/run.test.ts` (`reins node run`, through `runInstalledNode`): a refused node records the refusal, a node does not run while another of its home runs, and a bundle told to update installs the build and exits for its launcher, or says to start it again without one. `setup.test.ts`: setup's refusals, its idempotency, a newer build replacing a running node, a refused node, and status and stop after it, against a stand-in server with a stand-in bundle that runs the CLI's source. `control.test.ts`: start without a launcher, a status file whose pid is another process's, and, with a stand-in node under the real launcher that updates once, `status`, `start` and `stop` while the launcher restarts it on the new build.
- `packages/backend/src/__tests__/node-install.process-test.ts` (`bun run test:process`): the install command against a server process serving its bundle (test hooks), with Bun pre-seeded in the node home: it installs, pairs and starts a node that connects; run again it pairs nothing; `status` and `stop` follow it. And the acceptance test: a source on the installed node is added to a project (`POST /api/projects/:id/sources`), a session moved there completes a turn with a `bash` call, then the server restarts on another build (without test hooks; same port and data) and the node is told to update, downloads it, flips `current`, restarts through its launcher and reconnects announcing it (`GET /api/nodes` shows it `current`, `reins node status` connected).
- `packages/backend/src/__tests__/nodes/node-builds.test.ts`: the server's rule for a hello's build (update whatever the protocol, current, from source, no build to offer, a build still running, authentication and revocation first) and the node view's `build`.
