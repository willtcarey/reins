# The node bundle

A remote node runs Reins from one file, `reins.js`: the `reins` command and all of the node (`packages/cli`, `packages/node`, `@reins/node-protocol`, `@reins/client`, Pi and their dependencies), built by the server from its own checkout (`bun build --target bun`). Bun is the only other thing the machine needs. The **build ID** is the sha256 of the file, and the file also holds `docs/features`, so one ID names the code and the docs a node runs. Why the server delivers the node's code, and the `~/.reins` layout, launcher and updates around it, are in [the node architecture plan](../plans/node-architecture.md) (*Versions*, *Code delivery*). This doc covers the bundle itself: what is in it, how it is built and what it does when it starts.

Not built yet: the server building it at startup, the manifest, the install script, the launcher and updates. Until then `buildNodeBundle` is called only by tests.

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

`bun --no-install <dir>/reins.js <command> …`, from any directory, with no `node_modules`: `--no-install` makes a missing module fail instead of being fetched. Any `reins` command works (`node pair`, `node source add`, `node run`, …). The entry (`packages/cli/src/bundle/entry.ts`), before anything of Pi is evaluated:

1. Sets, where the launcher has not (an empty value counts as unset):
   - `PI_PACKAGE_DIR=<dir>`. Pi reads `package.json` in its package directory as its modules load (`config.js`: its app name, config directory and version), and without this it walks up from the bundle and adopts the nearest one, whose `piConfig` would move Pi's agent directory. `<dir>` has none, so Pi uses its defaults; its `VERSION` reads `0.0.0`, which only Pi's CLI and self-update use. This is why the entry imports the rest of the code dynamically, after setting it.
   - `PI_OFFLINE=1`, so Pi never installs a package its `settings.json` lists.
   - `REINS_DOCS_DIR=<dir>/docs`, where the node's environment prompt names the REINS docs (node-runtime.md *Assembly*).
2. Writes the docs it carries to `<dir>/docs/features/` unless `<dir>/docs` exists (`unpackDocs`, `packages/cli/src/bundle/docs.ts`): into a temporary directory beside it, renamed into place, so no one sees half of them; of runs racing to unpack, one wins and the others leave its docs alone. A failure (a read-only directory) is printed and the command runs anyway.
3. Registers the Pi modules a bundle cannot load lazily (`registerBundledPiModules`, `@reins/node/bundled-pi`): Pi's OAuth flows (`registerBunOAuthFlows`, `@earendil-works/pi-ai/bun-oauth`) and its Bedrock provider (`setBedrockProviderModule` from `@earendil-works/pi-ai/compat` with `bedrockProviderModule` from `@earendil-works/pi-ai/bedrock-provider`). Pi otherwise loads them through computed `import()` paths, which a bundle cannot follow: every request on a stored OAuth credential would fail (`Cannot find module './anthropic.js'`). This is what Pi's own Bun binary does (`pi-coding-agent/dist/bun/runtime-setup.js`). The node run from source keeps loading them lazily.
4. Runs the command line (`runCli`, `packages/cli/src/cli.ts`) and exits with its code.

## Tests

- `packages/backend/src/__tests__/node-bundle/build.test.ts`: the build ID, determinism, test hooks in and out, Pi's OAuth flows compiled in, the guards.
- `packages/cli/src/bundle/docs.test.ts`: unpacking the docs.
- `packages/backend/src/__tests__/node-bundle.process-test.ts` (`bun run test:process`): builds a bundle with test hooks into a temporary directory outside the repository and, there, pairs it with a server process from this checkout, declares a checkout and runs the node over the WebSocket; a session completes a turn with a `bash` call, the docs are beside the bundle and the session's environment prompt names them.
