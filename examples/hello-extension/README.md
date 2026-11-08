# Hello: the example extension

A working reference for `docs/features/building-extensions.md` (*Set up an extension*): a backend part with a database and an HTTP method, a Lit frontend part with a Settings page, a test and a build. Reins typechecks, tests and lints it with its own code.

```sh
bun install && bun test && bun run build
bun run reins extension add "$PWD/examples/hello-extension" --local   # from the Reins checkout
```
