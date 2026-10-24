/**
 * File references in message text, a built-in feature: a message decorator for which words name a
 * file of the viewed session's source, and which lines, shown as the `file-reference` view, which
 * opens them in the Inspector. Built from the source's file listing; a reference counts only when it
 * resolves to a listed file.
 */

import {
  sameSource,
  type DecorationSpan,
  type Disposer,
  type Files,
  type InlineContext,
  type MessageDecorator,
  type ReinsSdk,
  type Source,
  type Workspace,
  type WorkspaceContext,
} from "@reins/sdk";
import { isBrowsablePath, toRelativePath } from "../../models/path-utils.js";

export interface FileReference {
  path: string;
  startLine?: number;
  endLine?: number;
}

/** The `file-reference` view, which this feature registers: a file named in message text, shown only inline. */
export type FileReferenceView = { view: "file-reference"; source: Source; path: string; startLine?: number; endLine?: number };

// `path:12`, `path:12-20`, `path:12:5` (a column), `path#L12`, `path#L12-L20`.
const LINE_SUFFIX = /^(.+?)(?::(\d+)(?:[-–](\d+))?(?::\d+)?|#L(\d+)(?:-L?(\d+))?)$/;
const LEADING = new Set(["(", "[", "{", "<", "\"", "'", "`", "*"]);
const TRAILING = new Set([".", ",", ";", ":", "!", "?", ")", "]", "}", ">", "\"", "'", "`", "*"]);

function lines(start: string | undefined, end: string | undefined): Pick<FileReference, "startLine" | "endLine"> {
  const startLine = Number(start);
  if (!start || startLine < 1) return {};
  const endLine = Number(end);
  if (!end || endLine === startLine) return { startLine };
  return endLine > startLine ? { startLine, endLine } : { startLine: endLine, endLine: startLine };
}

function lineLabel({ startLine, endLine }: FileReference): string {
  if (startLine == null) return "";
  return endLine == null ? `:${startLine}` : `:${startLine}-${endLine}`;
}

/** What activating a reference does, as its tooltip and accessible name. */
export function referenceLabel(reference: FileReference): string {
  return `Open ${reference.path}${lineLabel(reference)} in the Inspector`;
}

export class FileReferenceIndex {
  private paths: Set<string>;
  // A basename two files share maps to null: it names neither.
  private basenames = new Map<string, string | null>();
  private resolved = new Map<string, FileReference | null>();

  constructor(files: readonly string[], readonly source: Source) {
    this.paths = new Set(files);
    for (const path of files) {
      const basename = path.slice(path.lastIndexOf("/") + 1);
      this.basenames.set(basename, this.basenames.has(basename) ? null : path);
    }
  }

  /** The file a whole piece of text names (such as inline code), or null. */
  resolve(text: string): FileReference | null {
    let reference = this.resolved.get(text);
    if (reference === undefined) {
      reference = this.lookup(text);
      this.resolved.set(text, reference);
    }
    return reference;
  }

  /**
   * The longest reference in each word of prose, leaving out the punctuation around it. A reference
   * in prose needs a `/` or a line suffix: agents put a file named by itself in inline code, and a
   * lone name in prose is too often an ordinary word that happens to match one.
   */
  find(text: string): DecorationSpan[] {
    const targets: DecorationSpan[] = [];
    for (const word of text.matchAll(/\S+/g)) {
      const found = this.findInWord(word[0]);
      if (found) targets.push({ start: word.index + found.start, end: word.index + found.end, view: this.view(found.reference) });
    }
    return targets;
  }

  /** The reference a whole inline-code span is, or null. */
  resolveCode(code: string): FileReferenceView | null {
    const reference = this.resolve(code.trim());
    return reference ? this.view(reference) : null;
  }

  private view(reference: FileReference): FileReferenceView {
    return { view: "file-reference", source: this.source, ...reference };
  }

  private findInWord(word: string): { start: number; end: number; reference: FileReference } | null {
    if (!/[./]/.test(word) || word.includes("://")) return null;
    let start = 0;
    while (start < word.length && LEADING.has(word[start]!)) start += 1;
    for (let end = word.length; end > start; end -= 1) {
      const text = word.slice(start, end);
      const reference = this.resolve(text);
      if (reference && (text.includes("/") || reference.startLine != null)) return { start, end, reference };
      if (!TRAILING.has(word[end - 1]!)) return null;
    }
    return null;
  }

  private lookup(text: string): FileReference | null {
    if (text.includes("://")) return null;
    const suffix = LINE_SUFFIX.exec(text);
    const path = this.projectPath(suffix ? suffix[1]! : text);
    if (!path) return null;
    const found = this.paths.has(path) ? path : path.includes("/") ? null : this.basenames.get(path);
    if (!found) return null;
    if (!suffix) return { path: found };
    return { path: found, ...lines(suffix[2] ?? suffix[4], suffix[3] ?? suffix[5]) };
  }

  private projectPath(text: string): string | null {
    const relative = toRelativePath(text, this.source.path).replace(/^\.\//, "");
    if (!relative || !isBrowsablePath(relative, null)) return null;
    return relative;
  }
}

/** Decorates files of the viewed session's source, once its listing has loaded (never while its node is offline). */
class FileReferences implements MessageDecorator {
  // One index per listing, so resolutions are cached until the listing changes.
  private indexes = new WeakMap<readonly string[], FileReferenceIndex>();
  private decorated: Source | null = null;

  constructor(private readonly files: Files) {}

  decorate(text: string, { source }: WorkspaceContext): DecorationSpan[] {
    return this.index(source)?.find(text) ?? [];
  }

  decorateCode(code: string, { source }: WorkspaceContext): FileReferenceView | null {
    return this.index(source)?.resolveCode(code) ?? null;
  }

  onChange(listener: () => void): Disposer {
    let seen = this.decoratedListing();
    return this.files.subscribe(() => {
      const listing = this.decoratedListing();
      if (listing === seen) return;
      seen = listing;
      listener();
    });
  }

  private decoratedListing(): readonly string[] | null {
    return this.decorated ? this.files.listing(this.decorated).data : null;
  }

  private index(source: Source | null): FileReferenceIndex | null {
    this.decorated = source;
    const listing = this.files.listing(source).data;
    if (!source || !listing) return null;
    let index = this.indexes.get(listing);
    if (!index || !sameSource(index.source, source)) {
      index = new FileReferenceIndex(listing, source);
      this.indexes.set(listing, index);
    }
    return index;
  }
}

/**
 * Draws a reference as its text, as a control that opens its file in the Inspector. It stays text
 * rather than becoming a `<button>`, so it can be selected and wraps with the prose around it.
 */
export function referenceMount(workspace: Workspace) {
  return (target: HTMLElement, reference: FileReferenceView, { original }: InlineContext): void => {
    const control = target.ownerDocument.createElement("span");
    const open = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      workspace.open({ ...reference, view: "file" }, { in: "inspector" });
    };
    control.className = "file-reference";
    control.setAttribute("role", "button");
    control.setAttribute("tabindex", "0");
    control.title = referenceLabel(reference);
    control.addEventListener("click", open);
    control.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") open(event);
    });
    control.append(original());
    target.append(control);
  };
}

export function registerFileReferences(reins: ReinsSdk): Disposer {
  const disposers = [
    reins.views.register("file-reference", { inline: { mount: referenceMount(reins.workspace) } }),
    reins.messages.registerDecorator(new FileReferences(reins.files)),
  ];
  return () => disposers.forEach((dispose) => dispose());
}

declare module "@reins/sdk" {
  interface ViewTypes {
    "file-reference": FileReferenceView;
  }
}
