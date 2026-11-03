/**
 * The skills a session can invoke, per location (a node and a path), for the composer's `/name` suggestions:
 * a session's composer asks for its placement, the new session page for the location chosen. Best effort:
 * loaded the first time a location is asked for and kept; a node that could not answer is asked again
 * on an ask after `RETRY_MS`.
 */

import type { InjectedSkillInfo } from "@backend/routes/skills.js";
import type { Source } from "@reins/sdk";
import { api } from "../api.js";

const NONE: readonly InjectedSkillInfo[] = [];
const RETRY_MS = 30_000;

interface Entry { skills: readonly InjectedSkillInfo[]; loading: boolean; retryAt: number | null }

export class LocationSkills {
  private entries = new Map<string, Entry>();
  private listeners = new Set<() => void>();

  constructor(private readonly now: () => number = Date.now) {}

  /** The location's skills, synchronously, so they can be read while suggesting: none until they are loaded. */
  get(location: Source | null): readonly InjectedSkillInfo[] {
    if (!location) return NONE;
    const key = `${location.nodeId}\0${location.path}`;
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { skills: NONE, loading: false, retryAt: 0 };
      this.entries.set(key, entry);
    }
    if (!entry.loading && entry.retryAt !== null && this.now() >= entry.retryAt) this.load(location, entry);
    return entry.skills;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private load(location: Source, entry: Entry): void {
    entry.loading = true;
    const unavailable = () => {
      entry.loading = false;
      entry.retryAt = this.now() + RETRY_MS;
    };
    api.skills.at(location.nodeId, location.path).then(({ skills, available }) => {
      if (!available) return unavailable();
      entry.loading = false;
      entry.retryAt = null;
      entry.skills = skills;
      for (const listener of this.listeners) listener();
    }, unavailable);
  }
}
