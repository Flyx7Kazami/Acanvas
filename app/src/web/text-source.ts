import { editableTextBytes } from '../shared/content-types.js';

type Request = { controller: AbortController; promise: Promise<string>; readers: number };
const requests = new Map<string, Request>();

/** Immutable asset URLs share their in-flight read; each editor owns its text and version. */
export function acquireTextSource(src: string) {
  let request = requests.get(src);
  if (!request) {
    const controller = new AbortController();
    const promise = (async () => {
      const response = await fetch(src, { credentials: 'same-origin', signal: controller.signal });
      if (!response.ok) throw new Error('The text is unavailable.');
      if (Number(response.headers.get('Content-Length')) > editableTextBytes) throw new Error('Notes and Markdown stay within 2 MB.');
      const source = await response.text();
      if (new TextEncoder().encode(source).byteLength > editableTextBytes) throw new Error('Notes and Markdown stay within 2 MB.');
      return source;
    })();
    request = { controller, promise, readers: 0 };
    requests.set(src, request);
    const current = request;
    const clear = () => { if (requests.get(src) === current) requests.delete(src); };
    void promise.then(clear, clear);
  }
  request.readers += 1;
  const current = request;
  let active = true;
  return {
    promise: current.promise,
    release() {
      if (!active) return;
      active = false;
      current.readers -= 1;
      if (current.readers === 0 && requests.get(src) === current) {
        requests.delete(src);
        current.controller.abort();
      }
    },
  };
}
