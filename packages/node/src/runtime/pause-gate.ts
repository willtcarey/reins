/**
 * Holds runs at their clean pause points while closed (ADR-021): the assistant step's `before_request`
 * (the run is `assistant.ready` or `assistant.retry_wait`, its request not yet recorded) and
 * `before_tool` (the call is still `planned`). A run held there and then cut off loses nothing: Pi resumes
 * it into a fresh request, or runs the tool normally. One gate per node, shared by its runtimes; see
 * `AgentHarnessPiRuntime.isPaused`.
 */
export class PauseGate {
  private opened: PromiseWithResolvers<void> | undefined;

  get closed(): boolean { return this.opened !== undefined; }

  close(): void { this.opened ??= Promise.withResolvers(); }

  open(): void {
    this.opened?.resolve();
    this.opened = undefined;
  }

  /** Resolves once the gate is open or `signal` aborts (an abort, or the runtime closing). Never rejects:
   * Pi catches a throwing hook, and a throwing `before_tool` blocks its tool. */
  async pass(signal: AbortSignal | undefined): Promise<void> {
    const opened = this.opened;
    if (!opened || signal?.aborted) return;
    const aborted = Promise.withResolvers<void>();
    const onAbort = () => aborted.resolve();
    signal?.addEventListener("abort", onAbort, { once: true });
    try { await Promise.race([opened.promise, aborted.promise]); }
    finally { signal?.removeEventListener("abort", onAbort); }
  }
}
