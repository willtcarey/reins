/** Uploads go through XHR (`models/api.ts`), which bun's test environment does not have. */

export interface RecordedUpload {
  method: string;
  url: string;
  /** The names of the files the form data carries under "files". */
  files: string[];
}

type Respond = (upload: RecordedUpload) => { status: number; body: unknown };

/** Installs a fake `XMLHttpRequest` that records each upload, reports it half then fully sent, and answers
 * with `respond`'s JSON; `restore` removes it. */
export function fakeXhr(respond: Respond = () => ({ status: 200, body: { uploaded: [] } })) {
  const uploads: RecordedUpload[] = [];
  const previous = Reflect.get(globalThis, "XMLHttpRequest");

  class FakeXMLHttpRequest {
    status = 0;
    statusText = "";
    responseText = "";
    private method = "";
    private url = "";
    private listeners = new Map<string, Array<() => void>>();
    private progressListeners: Array<(event: { lengthComputable: boolean; loaded: number; total: number }) => void> = [];
    readonly upload = {
      addEventListener: (_type: string, listener: (event: { lengthComputable: boolean; loaded: number; total: number }) => void) => {
        this.progressListeners.push(listener);
      },
    };

    open(method: string, url: string) {
      this.method = method;
      this.url = url;
    }

    setRequestHeader() {}

    addEventListener(type: string, listener: () => void) {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    }

    getResponseHeader(name: string) {
      return name.toLowerCase() === "content-type" ? "application/json" : null;
    }

    abort() {}

    send(body: FormData) {
      const upload = {
        method: this.method,
        url: this.url,
        files: body.getAll("files").map(file => (typeof file === "string" ? file : file.name)),
      };
      uploads.push(upload);
      queueMicrotask(() => {
        for (const listener of this.progressListeners) listener({ lengthComputable: true, loaded: 1, total: 2 });
        const { status, body: responseBody } = respond(upload);
        this.status = status;
        this.responseText = JSON.stringify(responseBody);
        for (const listener of this.listeners.get("load") ?? []) listener();
      });
    }
  }

  Reflect.set(globalThis, "XMLHttpRequest", FakeXMLHttpRequest);
  return {
    uploads,
    restore: () => {
      if (previous === undefined) Reflect.deleteProperty(globalThis, "XMLHttpRequest");
      else Reflect.set(globalThis, "XMLHttpRequest", previous);
    },
  };
}
