/**
 * Fixtures for the browser's shared vocabulary (#541): a valid and an
 * invalid instance of every browser schema the export writes (the
 * page-driver contract's verbs, calls and answers, the page policy, bridge
 * protocol version 2's messages, the port file and the `browser.*` keys).
 * `fixtures.ts` folds them into the package's fixture table.
 */

interface Fixtures {
  readonly valid: readonly unknown[];
  readonly invalid: readonly unknown[];
}

const environmentId = "0f8fad5b-d9cb-469f-a165-70867728950e";
const chromeId = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const at = "2026-09-29T01:02:03.456Z";
const secret = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
const nonce = "202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f";
const proof = "f11850ce2b92900b74888d4b8512576ee53d386643a045a8a46d9e0a3e760bfd";

const paypal = { id: "preset:*.paypal.com", pattern: "*.paypal.com", note: "Payments and money movement.", preset: true, enabled: true };
const policy = { devSites: ["localhost", "*.myapp.test"], evaluateEverywhere: false, deepReadEverywhere: false, browserDomains: [paypal] };
const location = { url: "https://example.com/", title: "Example" };
const snapshotText = { text: '- button "Buy" [ref=e1]', totalChars: 23, truncated: false };

/** Each verb's arguments and value, valid and not. */
const verbs: Record<string, { readonly args: Fixtures; readonly value: Fixtures }> = {
  open: {
    args: { valid: [{}, { url: "https://example.com/" }, { url: "https://example.com/", snapshot: { filter: "interactive", maxChars: 12_000 } }], invalid: [{ url: "" }, { snapshot: { maxChars: 0 } }, null] },
    value: { valid: [location, { ...location, snapshot: snapshotText, challenge: "cloudflare" }], invalid: [{ url: "https://example.com/" }, { ...location, challenge: "captcha" }] },
  },
  navigate: {
    args: { valid: [{ url: "https://example.com/" }, { url: "localhost:3000", snapshot: {} }], invalid: [{}, { url: "x".repeat(8_193) }] },
    value: { valid: [location], invalid: [{ ...location, snapshot: { text: "x" } }, "https://example.com/"] },
  },
  snapshot: {
    args: { valid: [{}, { filter: "all", depth: 2, ref: "f1e4", maxChars: 200_000 }], invalid: [{ filter: "visible" }, { maxChars: 200_001 }, { depth: 0 }] },
    value: { valid: [{ ...location, ...snapshotText }, { ...location, ...snapshotText, truncated: true, challenge: "hcaptcha" }], invalid: [location, { ...location, ...snapshotText, totalChars: -1 }] },
  },
  click: {
    args: { valid: [{ target: { ref: "e12" } }, { target: { selector: "button.buy" }, snapshot: {} }], invalid: [{ target: { ref: "e12", selector: "a" } }, { target: {} }, {}] },
    value: { valid: [location], invalid: [{}, null] },
  },
  clickAt: {
    args: { valid: [{ x: 0, y: 0 }, { x: 640.5, y: 400, snapshot: { maxChars: 12_000 } }], invalid: [{ x: -1, y: 0 }, { x: 1 }, { x: "1", y: 1 }] },
    value: { valid: [location], invalid: [{ title: "x" }] },
  },
  type: {
    args: { valid: [{ target: { ref: "e3" }, text: "hello" }, { target: { selector: "#q" }, text: "" }], invalid: [{ target: { ref: "e3" } }, { text: "hello" }] },
    value: { valid: [location], invalid: [{ url: 1, title: "x" }] },
  },
  read: {
    args: { valid: [{}, { offset: 24_000, links: true }], invalid: [{ offset: -1 }, { offset: 1.5 }, { links: "yes" }] },
    value: {
      valid: [
        { ...location, source: "article", text: "# Example", offset: 0, totalChars: 30_000, nextOffset: 24_000 },
        { ...location, source: "snapshot", text: "- heading", offset: 0, totalChars: 9, nextOffset: null, challenge: "javascript" },
      ],
      invalid: [{ ...location, source: "readability", text: "", offset: 0, totalChars: 0, nextOffset: null }, { ...location, source: "article", text: "", offset: 0, totalChars: 0 }],
    },
  },
  screenshot: {
    args: { valid: [{}], invalid: [null, "now", []] },
    value: { valid: [{ mimeType: "image/jpeg", data: "/9j/4AAQSkZJRg==" }, { mimeType: "image/png", data: "" }], invalid: [{ mimeType: "image/gif", data: "R0lG" }, { mimeType: "image/jpeg", data: "not base64!" }] },
  },
  scroll: {
    args: { valid: [{ to: { direction: "down" } }, { to: { direction: "left", amount: 0.5 } }, { to: { ref: "e9" } }], invalid: [{ to: { direction: "sideways" } }, { to: { direction: "up", amount: 0 } }, { to: { direction: "down", ref: "e9" } }, {}] },
    value: { valid: [location], invalid: [{}] },
  },
  waitFor: {
    args: {
      valid: [{ until: { text: "Loaded" } }, { until: { ref: "e3", timeoutMs: 60_000 } }, { until: { ms: 0 } }],
      invalid: [{ until: { text: "Loaded", ms: 5 } }, { until: { ms: -1 } }, { until: { text: "" } }, { until: { ref: "e3", timeoutMs: 0 } }],
    },
    value: { valid: [location], invalid: [null] },
  },
  console: {
    args: { valid: [{}], invalid: [null] },
    value: {
      valid: [[], [{ level: "error", text: "Uncaught TypeError", source: "app.js:12", at }, { level: "log", text: "ready", at }]],
      invalid: [[{ level: "fatal", text: "x", at }], [{ level: "log", text: "x", at: 1_700_000_000 }], {}],
    },
  },
  network: {
    args: { valid: [{}, { failedOnly: true }], invalid: [{ failedOnly: "yes" }] },
    value: {
      valid: [[], [{ method: "GET", url: "https://example.com/api", status: 500, resourceType: "fetch", durationMs: 12.5, at }, { method: "POST", url: "https://example.com/x", failure: "net::ERR_FAILED", at }]],
      invalid: [[{ method: "GET", url: "https://example.com/", status: 200.5, at }], [{ url: "https://example.com/", at }]],
    },
  },
  cookies: {
    args: { valid: [{}], invalid: ["cookies"] },
    value: {
      valid: [[], [{ name: "session", value: "v", domain: ".example.com", path: "/", expires: at, httpOnly: true, secure: true, sameSite: "Lax" }, { name: "id", domain: "example.com", path: "/", httpOnly: false, secure: false }]],
      invalid: [[{ name: "session", domain: "example.com", path: "/", httpOnly: true, secure: true, sameSite: "lax" }], [{ name: "id" }]],
    },
  },
  storage: {
    args: { valid: [{}], invalid: [1] },
    value: { valid: [{ origin: "http://localhost:3000", local: { theme: "dark" }, session: {} }], invalid: [{ origin: "http://localhost:3000", local: { count: 1 }, session: {} }, { origin: "x", local: {} }] },
  },
  evaluate: {
    args: { valid: [{ expression: "document.title" }], invalid: [{ expression: "" }, {}] },
    value: { valid: [{ result: "Example" }, { result: null }, { result: { a: [1, "two", false] } }], invalid: [{}, "Example"] },
  },
  close: {
    args: { valid: [{}], invalid: [null] },
    value: { valid: [null], invalid: [{}, false] },
  },
};

const command = { verb: "click", args: { target: { ref: "e12" } } };
const call = { pageKey: `${environmentId}/${chromeId}`, command, allowance: { host: "www.paypal.com" } };
const denylisted = { ok: false, reason: "www.paypal.com is on the denylist (browser domains: *.paypal.com).", denylist: { frame: "top-level", match: { section: "browserDomains", entry: paypal, matched: "https://www.paypal.com/" } } };

const bridgeFromExtension = {
  announce: { type: "announce", protocolVersion: 2, extensionVersion: "0.4.2", name: "Work" },
  pair: { type: "pair", code: "K7Q2MXH4", name: "Work" },
  hello: { type: "hello", protocolVersion: 2, extensionVersion: "0.4.2", environmentId, chromeId, name: "Work" },
  proof: { type: "proof", mac: proof },
  result: { type: "result", id: "call-1", result: { ok: true, value: location } },
} as const;

const bridgeFromEnvironment = {
  announced: { type: "announced", environmentId, environmentName: "SYSTEM-SERVER" },
  paired: { type: "paired", chromeId, secret, policy },
  challenge: { type: "challenge", environmentId, nonce },
  ready: { type: "ready", policy },
  policy: { type: "policy", policy },
  call: { type: "call", id: "call-1", ...call },
} as const;

const limits = { maxContexts: 2, idleMinutes: 10, tabHeapMb: 500, exitMinutes: 5 };

/** The environment's side of the extension (#547): what browser.status answers. */
const listening = { state: "listening", port: 47615 };
const portInUse = { state: "not-listening", reason: "port-in-use", message: "Ports 47615 to 47634 on loopback are all in use." };
const folder = { path: "/home/david/.local/state/agent-harness/extension/current", problem: null };
const noBuild = { path: "C:\\Users\\david\\AppData\\Local\\agent-harness\\extension\\current", problem: "This environment carries no built extension." };
const status = { listener: listening, folder, shippedVersion: "0.4.2", unpairedConnected: true };
const statusFixtures: Fixtures = {
  valid: [status, { listener: portInUse, folder: noBuild, shippedVersion: null, unpairedConnected: false }],
  invalid: [{ ...status, unpairedConnected: undefined }, { ...status, shippedVersion: "" }, { ...status, listener: { state: "listening" } }, { listener: listening, folder }],
};

/** Pairing and paired Chromes (#548): the code, a Chrome as the list answers it, the chrome stream and chrome.updated. */
const code = { code: "K7Q2MXH4", expiresAt: at };
const chrome = { id: chromeId, name: "Work", pairedAt: at, lastConnectedAt: at, lastReportedVersion: "0.4.2", connected: true, outdated: false };
const chromeFixtures: Fixtures = {
  valid: [chrome, { ...chrome, name: "A browser", connected: false, outdated: true }],
  invalid: [{ ...chrome, name: "" }, { ...chrome, name: "x".repeat(81) }, { ...chrome, id: "work" }, { ...chrome, connected: undefined }, { ...chrome, lastReportedVersion: "" }],
};
const commandId = "5b2d0c1e-8f0a-4d5c-9e3b-2a1f0c9d8e7b";

/** Params and result instances for the browser methods. */
export const browserMethodFixtures: Record<string, { params: Fixtures; result: Fixtures }> = {
  "browser.status": { params: { valid: [{}], invalid: [null, []] }, result: statusFixtures },
  "browser.pairing.code": {
    params: { valid: [{}], invalid: [null, []] },
    result: { valid: [code], invalid: [{ ...code, code: "K7Q2MXH" }, { ...code, code: "K7Q2MXH1" }, { ...code, expiresAt: "soon" }, { code: code.code }] },
  },
  "browser.chromes.list": {
    params: { valid: [{}], invalid: [null, []] },
    result: { valid: [{ chromes: [] }, { chromes: [chrome, chromeFixtures.valid[1]] }], invalid: [{}, { chromes: [{ ...chrome, outdated: undefined }] }] },
  },
  "browser.chromes.rename": {
    params: { valid: [{ commandId, chromeId, name: "Personal" }, { commandId, chromeId, name: "" }], invalid: [{ commandId, chromeId }, { commandId, name: "Work" }, { chromeId, name: "Work" }, { commandId, chromeId, name: "x".repeat(1_001) }] },
    result: { valid: [{ chrome }], invalid: [{}, { chrome: { ...chrome, name: "" } }] },
  },
  "browser.chromes.unpair": {
    params: { valid: [{ commandId, chromeId }], invalid: [{ commandId }, { chromeId }, { commandId, chromeId: "work" }] },
    result: { valid: [{ chrome: { ...chrome, connected: false } }], invalid: [{}, { chrome: { id: chromeId } }] },
  },
};

export const browserSchemaFixtures: Record<string, Fixtures> = {
  "browser/page-driver-kind.json": { valid: ["chrome", "headless", "dock"], invalid: ["none", "extension", ""] },
  "browser/page-key.json": { valid: [`${environmentId}/${chromeId}`, "k"], invalid: ["", "x".repeat(257), 1] },
  ...Object.fromEntries(
    Object.entries(verbs).flatMap(([verb, { args, value }]) => [
      [`browser/verbs/${verb}/args.json`, args],
      [`browser/verbs/${verb}/value.json`, value],
    ]),
  ),
  "browser/page-command.json": {
    valid: [command, { verb: "screenshot", args: {} }, { verb: "waitFor", args: { until: { ms: 500 } } }],
    invalid: [{ verb: "focus", args: {} }, { verb: "click", args: {} }, { verb: "click" }, { args: {} }],
  },
  "browser/one-time-allowance.json": { valid: [{ host: "www.paypal.com" }], invalid: [{ host: "" }, {}, "www.paypal.com"] },
  "browser/page-call.json": { valid: [call, { pageKey: "k", command: { verb: "close", args: {} } }], invalid: [{ pageKey: "", command }, { pageKey: "k" }, { pageKey: "k", command, allowance: {} }] },
  "browser/page-refusal.json": {
    valid: [{ ok: false, reason: "No element matches that selector." }, denylisted, { ...denylisted, denylist: { ...denylisted.denylist, frame: "sub-frame" } }],
    invalid: [{ ok: false, reason: "" }, { ok: true, reason: "x" }, { ...denylisted, denylist: { ...denylisted.denylist, frame: "iframe" } }, { ...denylisted, denylist: { frame: "top-level" } }],
  },
  "browser/page-outcome.json": {
    valid: [{ ok: true, value: location }, { ok: true, value: null, notice: "The wait was clamped to 30 seconds." }, denylisted],
    invalid: [{ ok: true }, { ok: false }, { ok: true, value: location, notice: "" }],
  },
  "browser/page-policy.json": {
    valid: [policy, { devSites: [], evaluateEverywhere: true, deepReadEverywhere: true, browserDomains: [] }],
    invalid: [{ ...policy, devSites: ["https://myapp.test"] }, { ...policy, evaluateEverywhere: "no" }, { ...policy, browserDomains: [{ pattern: "*.paypal.com" }] }, { devSites: [] }],
  },
  "browser/chrome-id.json": { valid: [chromeId], invalid: ["work-chrome", "", 7] },
  "browser/port-file.json": {
    valid: [{ port: 47615, environmentId, environmentName: "SYSTEM-SERVER", harnessVersion: "0.4.2" }],
    invalid: [
      { port: 0, environmentId, environmentName: "SYSTEM-SERVER", harnessVersion: "0.4.2" },
      { port: 65_536, environmentId, environmentName: "SYSTEM-SERVER", harnessVersion: "0.4.2" },
      { port: 47615, environmentId: "server", environmentName: "SYSTEM-SERVER", harnessVersion: "0.4.2" },
      { port: 47615, environmentId, environmentName: "", harnessVersion: "0.4.2" },
      { port: 47615 },
    ],
  },
  "browser/bridge/announce.json": {
    valid: [bridgeFromExtension.announce, { ...bridgeFromExtension.announce, name: "" }],
    invalid: [{ ...bridgeFromExtension.announce, protocolVersion: 0 }, { ...bridgeFromExtension.announce, extensionVersion: "" }, { type: "announce", protocolVersion: 2 }],
  },
  "browser/bridge/pair.json": { valid: [bridgeFromExtension.pair, { type: "pair", code: "k7q2-mxh4", name: "" }], invalid: [{ type: "pair", code: "", name: "Work" }, { type: "pair", code: "K7Q2MXH4" }] },
  "browser/bridge/hello.json": {
    valid: [bridgeFromExtension.hello],
    invalid: [{ ...bridgeFromExtension.hello, environmentId: "server" }, { ...bridgeFromExtension.hello, chromeId: "work" }, { type: "hello", protocolVersion: 2, extensionVersion: "0.4.2", chromeId, name: "Work" }],
  },
  "browser/bridge/proof.json": { valid: [bridgeFromExtension.proof], invalid: [{ type: "proof", mac: proof.toUpperCase() }, { type: "proof", mac: proof.slice(2) }, { type: "proof" }] },
  "browser/bridge/result.json": {
    valid: [bridgeFromExtension.result, { type: "result", id: "call-2", result: denylisted }],
    invalid: [{ type: "result", id: "", result: { ok: true, value: null } }, { type: "result", id: "call-1", result: { ok: false } }, { type: "result", id: "call-1" }],
  },
  "browser/bridge/announced.json": { valid: [bridgeFromEnvironment.announced], invalid: [{ type: "announced", environmentId, environmentName: "" }, { type: "announced", environmentName: "SYSTEM-SERVER" }] },
  "browser/bridge/paired.json": {
    valid: [bridgeFromEnvironment.paired],
    invalid: [{ ...bridgeFromEnvironment.paired, secret: "secret-for-tests" }, { ...bridgeFromEnvironment.paired, chromeId: "work" }, { type: "paired", chromeId, secret }],
  },
  "browser/bridge/challenge.json": { valid: [bridgeFromEnvironment.challenge], invalid: [{ type: "challenge", environmentId, nonce: "n" }, { type: "challenge", nonce }] },
  "browser/bridge/ready.json": { valid: [bridgeFromEnvironment.ready], invalid: [{ type: "ready" }, { type: "ready", policy: {} }] },
  "browser/bridge/policy.json": { valid: [bridgeFromEnvironment.policy], invalid: [{ type: "policy" }, { type: "policy", policy: { ...policy, devSites: "localhost" } }] },
  "browser/bridge/call.json": {
    valid: [bridgeFromEnvironment.call, { type: "call", id: "call-2", pageKey: "k", command: { verb: "evaluate", args: { expression: "1 + 1" } } }],
    invalid: [{ ...bridgeFromEnvironment.call, id: "" }, { ...bridgeFromEnvironment.call, command: { verb: "tab", args: { id: 3 } } }, { type: "call", id: "call-1", command }],
  },
  "browser/bridge/ping.json": { valid: [{ type: "ping" }], invalid: [{ type: "pong" }, {}] },
  "browser/bridge/pong.json": { valid: [{ type: "pong" }], invalid: [{ type: "ping" }, {}] },
  "browser/bridge/refused.json": { valid: [{ type: "refused", reason: "Another environment holds this port." }], invalid: [{ type: "refused", reason: "" }, { type: "refused" }] },
  "browser/bridge/from-extension.json": {
    valid: [...Object.values(bridgeFromExtension), { type: "ping" }, { type: "pong" }, { type: "refused", reason: "Unpaired." }],
    invalid: [bridgeFromEnvironment.call, bridgeFromEnvironment.challenge, { type: "hello" }, {}],
  },
  "browser/bridge/from-environment.json": {
    valid: [...Object.values(bridgeFromEnvironment), { type: "ping" }, { type: "pong" }, { type: "refused", reason: "No longer paired." }],
    invalid: [bridgeFromExtension.hello, bridgeFromExtension.proof, { type: "call" }, {}],
  },
  "browser/status/listener.json": {
    valid: [listening, portInUse, { state: "not-listening", reason: "bind-failed", message: "Binding 127.0.0.1 failed: EADDRNOTAVAIL." }],
    invalid: [{ state: "listening", port: 0 }, { state: "not-listening", reason: "port-in-use" }, { state: "not-listening", reason: "busy", message: "Busy." }, { port: 47615 }],
  },
  "browser/status/folder.json": { valid: [folder, noBuild], invalid: [{ path: "", problem: null }, { path: folder.path, problem: "" }, { path: folder.path }] },
  "browser/status/status.json": statusFixtures,
  "browser/chrome-pairing-code.json": { valid: ["K7Q2MXH4", "23456789"], invalid: ["K7Q2MXH", "K7Q2MXH4R", "k7q2mxh4", "K7Q2-MXH", "K7Q2MXH1"] },
  "browser/chrome-name.json": { valid: ["Work", "A browser", "x".repeat(80)], invalid: ["", "x".repeat(81), 7] },
  "browser/paired-chrome.json": chromeFixtures,
  "browser/chrome-event-type.json": { valid: ["chrome.paired", "chrome.renamed", "chrome.version-reported", "chrome.unpaired"], invalid: ["chrome.connected", "chrome.updated", ""] },
  "browser/chrome-events/chrome.paired.json": {
    valid: [{ name: "Work", extensionVersion: "0.4.2" }],
    invalid: [{ name: "Work" }, { name: "", extensionVersion: "0.4.2" }, { name: "Work", extensionVersion: "" }],
  },
  "browser/chrome-events/chrome.renamed.json": { valid: [{ name: "Personal" }], invalid: [{}, { name: "" }, { name: "x".repeat(81) }] },
  "browser/chrome-events/chrome.version-reported.json": { valid: [{ extensionVersion: "0.4.3" }], invalid: [{}, { extensionVersion: "" }] },
  "browser/chrome-events/chrome.unpaired.json": { valid: [{}], invalid: [null, "unpaired"] },
  "browser/chrome-change.json": { valid: ["paired", "renamed", "unpaired", "connected", "disconnected", "version"], invalid: ["proved", "chrome.paired", ""] },
  "browser/chrome-updated.json": {
    valid: [{ chromeId, name: "Work", change: "paired" }, { chromeId, name: "A browser", change: "disconnected" }],
    invalid: [{ chromeId, change: "paired" }, { chromeId, name: "Work", change: "proved" }, { chromeId: "work", name: "Work", change: "renamed" }],
  },
  "browser/extension-seen.json": {
    valid: [{ protocolVersion: 2, extensionVersion: "0.4.2" }, { protocolVersion: 1, extensionVersion: "0.4.2-beta.1" }],
    invalid: [{ protocolVersion: 0, extensionVersion: "0.4.2" }, { protocolVersion: 2, extensionVersion: "" }, { protocolVersion: 2 }],
  },
  "settings/keys/browser.devSites.json": { valid: [[], ["localhost", "*.myapp.test", "192.168.1.10"]], invalid: [["https://myapp.test"], ["myapp.test:3000"], "localhost"] },
  "settings/keys/browser.evaluateEverywhere.json": { valid: [true, false], invalid: [null, "true"] },
  "settings/keys/browser.deepReadEverywhere.json": { valid: [true, false], invalid: [null, 0] },
  "settings/keys/browser.reach.json": {
    valid: [{}, { "acc-1": "per-session", "acc-2": { chrome: { environmentId, chromeId } }, "acc-3": { chrome: { environmentId, chromeId: null } } }],
    invalid: [{ "acc-1": "headless" }, { "acc-1": { chrome: { environmentId } } }, { "acc-1": { chrome: { environmentId: "desktop", chromeId: null } } }, { "": "per-session" }, []],
  },
  "settings/keys/browser.headless.allowRuns.json": { valid: [true, false], invalid: [null, "on"] },
  "settings/keys/browser.headless.endpoint.json": {
    valid: [null, "http://browser:9222", "ws://127.0.0.1:9222/devtools/browser/abc", "wss://chromium.example.com/cdp"],
    invalid: ["", "browser:9222", "ftp://browser:9222", "http://"],
  },
  "settings/keys/browser.headless.executable.json": { valid: [null, "/usr/bin/chromium", "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"], invalid: ["", 1] },
  "settings/keys/browser.headless.limits.json": {
    valid: [limits, { maxContexts: 1, idleMinutes: 1, tabHeapMb: 1, exitMinutes: 1 }, { maxContexts: 16, idleMinutes: 1_440, tabHeapMb: 16_384, exitMinutes: 1_440 }],
    invalid: [{ ...limits, maxContexts: 0 }, { ...limits, idleMinutes: 0 }, { ...limits, tabHeapMb: 16_385 }, { ...limits, exitMinutes: 1.5 }, { maxContexts: 2 }],
  },
  "settings/keys/browser.internalHosts.json": { valid: [[], ["localhost", "127.0.0.1", "::1", "*.lan"]], invalid: [["http://localhost"], [""], "::1"] },
};
