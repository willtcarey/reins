# TODO

- [x] Syntax highlighting in the diff view
- [ ] Injected system prompt which talks more about the environment to bias the LLM towards file creation (may not actually need this)
- [ ] Worktrees/sandboxing code execution
- [ ] Better conversation design
- [ ] Conversation naming
- [ ] Sidebar updating
  - New sessions always say "empty" until page refresh
  - Switching projects doesn't clear the main view, and clicking the session on the new project is a no-op (thinks it's already loaded)
- [x] Working directory switcher/indicator
- [x] Diff view doesn't show untracked files
- [ ] Figure out how to run the service persistently
- [x] Mobile support
- [x] Image support in the chat interface
- [ ] CSS not rebuilding when Tailwind classes change
  - Adding or changing utility classes in `.ts` templates doesn't take effect until a manual `bun run build`. The `dev` script runs both Bun's JS bundler and `@tailwindcss/cli` with `--watch`, but Tailwind's watcher may not be picking up changes in `.ts` files as content sources, or the two watch processes (backgrounded with `&`) may not be coordinating reliably. Need to verify Tailwind's content detection config and consider a more integrated build pipeline.
