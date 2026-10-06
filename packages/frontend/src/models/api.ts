import { ReinsClient } from "@reins/client";

/** Sends an upload with XHR, the browser's only way to report upload progress. Resolves with the server's
 * response, errors included, for the client to decode; rejects as fetch does on network failure or abort. */
function xhrUpload(input: string, init: RequestInit, onProgress?: (percent: number) => void): Promise<Response> {
  return new Promise((resolve, reject) => {
    const { body, signal } = init;
    if (!(body instanceof FormData)) {
      reject(new TypeError("Uploads send form data"));
      return;
    }
    if (signal?.aborted) {
      reject(new DOMException("The operation was aborted", "AbortError"));
      return;
    }

    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    const cleanup = () => signal?.removeEventListener("abort", abort);
    xhr.open(init.method ?? "POST", input);
    new Headers(init.headers).forEach((value, name) => xhr.setRequestHeader(name, value));
    xhr.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) onProgress?.(Math.round((event.loaded / event.total) * 100));
    });
    xhr.addEventListener("load", () => {
      cleanup();
      if (xhr.status >= 200 && xhr.status < 300) onProgress?.(100);
      const contentType = xhr.getResponseHeader("Content-Type");
      resolve(new Response(xhr.responseText || null, {
        status: xhr.status,
        statusText: xhr.statusText,
        headers: contentType ? { "Content-Type": contentType } : {},
      }));
    });
    xhr.addEventListener("error", () => { cleanup(); reject(new TypeError("Network request failed")); });
    xhr.addEventListener("abort", () => { cleanup(); reject(new DOMException("The operation was aborted", "AbortError")); });
    signal?.addEventListener("abort", abort, { once: true });
    onProgress?.(0);
    xhr.send(body);
  });
}

/** The built-in frontend's client for its own server (relative paths). */
export const api = new ReinsClient({ upload: xhrUpload });
