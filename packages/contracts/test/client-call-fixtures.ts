/**
 * Fixtures for client-addressed calls (#554): a valid and an invalid
 * instance of the `client.call` payload, the `browser.chrome` and `browser.dock` verbs it
 * carries, and `client.answer`'s params and result. `fixtures.ts` folds them
 * into the package's fixture table.
 */

interface Fixtures {
  readonly valid: readonly unknown[];
  readonly invalid: readonly unknown[];
}

const callId = "5b2d0c1e-8f0a-4d5c-9e3b-2a1f0c9d8e7b";
const environmentId = "0f8fad5b-d9cb-469f-a165-70867728950e";
const chromeId = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const verb = {
  environmentId,
  chromeId,
  pageKey: `${environmentId}/${chromeId}`,
  command: { verb: "navigate", args: { url: "https://example.com/" } },
  deadline: "2026-09-24T00:00:20.000Z",
};
const dockVerb = { pageKey: verb.pageKey, command: verb.command, deadline: verb.deadline };
const call = { callId, clientSessionId: "cs-1", kind: "browser.chrome", payload: verb };
const outcome = { ok: true, value: { url: "https://example.com/", title: "Example" } };

export const clientCallMethodFixtures: Record<string, { params: Fixtures; result: Fixtures }> = {
  "client.answer": {
    params: {
      valid: [{ callId, ok: true, result: outcome }, { callId, ok: true, result: null }, { callId, ok: false, error: { code: "unsupported", message: "This client has no handler for browser.chrome." } }],
      invalid: [{ ok: true, result: null }, { callId: "call-1", ok: true, result: null }, { callId, result: null }, { callId, ok: false, error: { code: "", message: "No." } }, { callId, ok: false, error: { message: "No." } }],
    },
    result: { valid: [{ taken: true }, { taken: false }], invalid: [{}, { taken: "yes" }] },
  },
};

export const clientCallSchemaFixtures: Record<string, Fixtures> = {
  "client-calls/call-id.json": { valid: [callId], invalid: ["call-1", "", 1] },
  "client-calls/browser-chrome.json": {
    valid: [verb, { ...verb, chromeId: null, allowance: { host: "www.paypal.com" } }],
    invalid: [{ ...verb, environmentId: "desk" }, { ...verb, chromeId: undefined }, { ...verb, deadline: "soon" }, { ...verb, command: { verb: "focus", args: {} } }],
  },
  "client-calls/browser-dock.json": {
    valid: [dockVerb, { ...dockVerb, allowance: { host: "www.paypal.com" } }],
    invalid: [{ ...dockVerb, pageKey: "" }, { ...dockVerb, deadline: "soon" }, { ...dockVerb, deadline: undefined }, { ...dockVerb, command: { verb: "focus", args: {} } }],
  },
  "client-calls/call.json": {
    valid: [call, { ...call, payload: { ...verb, chromeId: null } }, { ...call, kind: "browser.dock", payload: dockVerb }],
    invalid: [{ ...call, kind: "browser.unknown" }, { ...call, clientSessionId: "" }, { ...call, callId: "call-1" }, { ...call, payload: { ...verb, deadline: undefined } }],
  },
};
