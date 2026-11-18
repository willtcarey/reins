/**
 * The extensions' session hooks (`reins.sessions.beforeRun`, `onSettled`, …), each kept under its name, so a new
 * hook is one entry in `SessionHookTypes` and a runner beside the others in this directory.
 */
import type { BeforeRunHook, SessionSettlement } from "@reins/sdk/server";

export type SettledHook = (settlement: SessionSettlement) => void | Promise<void>;

/** Each hook's signature, by its name in `reins.sessions`. */
export interface SessionHookTypes {
  beforeRun: BeforeRunHook;
  onSettled: SettledHook;
}

export type SessionHookName = keyof SessionHookTypes;

export interface RegisteredHook<K extends SessionHookName> { extension: string; hook: SessionHookTypes[K] }

export class SessionHooks {
  private readonly registered: { [K in SessionHookName]: RegisteredHook<K>[] } = { beforeRun: [], onSettled: [] };

  add<K extends SessionHookName>(name: K, extension: string, hook: SessionHookTypes[K]): () => Promise<void> {
    if (typeof hook !== "function") throw new Error(`A ${name} hook is a function`);
    const list: RegisteredHook<K>[] = this.registered[name];
    const entry = { extension, hook };
    list.push(entry);
    return async () => {
      const index = list.indexOf(entry);
      if (index >= 0) list.splice(index, 1);
    };
  }

  /** In the order they were registered: `Extensions.sessionHooks` gives them in their fixed order. */
  list<K extends SessionHookName>(name: K): readonly RegisteredHook<K>[] {
    return [...this.registered[name]];
  }

  countsOf(extension: string): Record<SessionHookName, number> {
    const count = (name: SessionHookName) => this.registered[name].filter(entry => entry.extension === extension).length;
    return { beforeRun: count("beforeRun"), onSettled: count("onSettled") };
  }
}
