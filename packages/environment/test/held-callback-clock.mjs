import { URL } from "node:url";

// A held transport clock: advance scheduling time before dispatching the replay, without a real sleep.
let now = 0;
const timers = [];
globalThis.AbortSignal.timeout = milliseconds => {
  const controller = new globalThis.AbortController();
  timers.push({ due: now + milliseconds, controller });
  return controller.signal;
};
const fetch = globalThis.fetch;
globalThis.fetch = (url, options) => {
  if (new URL(url).searchParams.get("code") === "second-code") {
    now += 2200;
    for (const timer of timers) if (timer.due <= now) timer.controller.abort(new globalThis.DOMException("Held transport clock elapsed", "TimeoutError"));
  }
  return fetch(url, options);
};
