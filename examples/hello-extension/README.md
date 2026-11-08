# Hello: the example extension

The extension that `docs/features/building-extensions.md` (*Set up an extension*) sets up, file for file. Reins typechecks, tests and lints it with its own code, and a test checks that the guide shows these files as they are: change both together.

```sh
bun install && bun test && bun run build
bun run reins extension add "$PWD/examples/hello-extension" --local   # from the Reins checkout
```
