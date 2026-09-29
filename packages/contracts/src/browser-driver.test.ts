import { describe, expect, it } from "vitest";
import {
  DEEP_PAGE_VERBS,
  PAGE_DRIVER_ABILITIES,
  PAGE_DRIVER_KINDS,
  PAGE_VERBS,
  PAGE_VERB_SCHEMAS,
  PageCall,
  PageCommand,
  PageOutcome,
  PageRefusal,
  SNAPSHOT_MAX_CHARS,
  WAIT_FOR_MS,
  denylistPresets,
  pageKeyOf,
  waitBoundMs,
} from "./index.js";

/**
 * The page-driver contract (browser spec, "One page driver for three
 * browsers" and "The tools"; ADR 0014; #541): every verb with its arguments
 * and its value, a refusal as a sentence the model can act on, the page key,
 * and the three kinds with their abilities. Its types are plain data, so the
 * contracts package stays free of DOM and Node types.
 */

const accepts = (verb: keyof typeof PAGE_VERB_SCHEMAS, part: "args" | "value", value: unknown): boolean => PAGE_VERB_SCHEMAS[verb][part].safeParse(value).success;

describe("the page-driver contract", () => {
  it("has the spec's verbs, in its order, the five deep verbs among them", () => {
    expect(PAGE_VERBS).toEqual([
      "open",
      "navigate",
      "snapshot",
      "click",
      "clickAt",
      "type",
      "read",
      "screenshot",
      "scroll",
      "waitFor",
      "console",
      "network",
      "cookies",
      "storage",
      "evaluate",
      "close",
    ]);
    expect(DEEP_PAGE_VERBS).toEqual(["console", "network", "cookies", "storage", "evaluate"]);
    expect(Object.keys(PAGE_VERB_SCHEMAS)).toEqual([...PAGE_VERBS]);
  });

  it("gives a Chrome every verb under the page policy, the headless browser every verb on every site, and the dock none of the deep verbs", () => {
    expect(PAGE_DRIVER_KINDS).toEqual(["chrome", "headless", "dock"]);
    expect(PAGE_DRIVER_ABILITIES.chrome).toEqual({ verbs: PAGE_VERBS, deepReadsByPolicy: true });
    expect(PAGE_DRIVER_ABILITIES.headless).toEqual({ verbs: PAGE_VERBS, deepReadsByPolicy: false });
    expect(PAGE_DRIVER_ABILITIES.dock.verbs).toEqual(["open", "navigate", "snapshot", "click", "clickAt", "type", "read", "screenshot", "scroll", "waitFor", "close"]);
    expect(PAGE_DRIVER_ABILITIES.dock.deepReadsByPolicy).toBe(false);
  });

  it("names a session's page by a key from the run environment's id and the session id, and no verb takes a tab id", () => {
    expect(pageKeyOf("0f8fad5b-d9cb-469f-a165-70867728950e", "7c9e6679-7425-40de-944b-e07fc1f90ae7")).toBe(
      "0f8fad5b-d9cb-469f-a165-70867728950e/7c9e6679-7425-40de-944b-e07fc1f90ae7",
    );
    const propertyNames = (node: unknown): string[] => {
      if (typeof node !== "object" || node === null) return [];
      const own = "properties" in node && typeof node.properties === "object" && node.properties !== null ? Object.keys(node.properties) : [];
      return [...own, ...Object.values(node).flatMap(propertyNames)];
    };
    for (const verb of PAGE_VERBS) expect(propertyNames(PAGE_VERB_SCHEMAS[verb].args.toJSONSchema()).filter((name) => /tab/i.test(name)), verb).toEqual([]);
  });

  it("takes an address, optional for open, and an interactive snapshot on request after an action", () => {
    expect(accepts("open", "args", {})).toBe(true);
    expect(accepts("open", "args", { url: "https://example.com/", snapshot: { filter: "interactive", maxChars: 12_000 } })).toBe(true);
    expect(accepts("navigate", "args", {})).toBe(false);
    expect(accepts("navigate", "args", { url: "" })).toBe(false);
    expect(accepts("clickAt", "args", { x: 640, y: 400, snapshot: {} })).toBe(true);
    expect(accepts("clickAt", "args", { x: -1, y: 0 })).toBe(false);
  });

  it("acts on an element by the ref a snapshot gave or by a selector, never both", () => {
    expect(accepts("click", "args", { target: { ref: "e12" } })).toBe(true);
    expect(accepts("click", "args", { target: { selector: "button.buy" } })).toBe(true);
    expect(accepts("click", "args", { target: { ref: "e12", selector: "button" } })).toBe(false);
    expect(accepts("click", "args", { target: {} })).toBe(false);
    expect(accepts("type", "args", { target: { ref: "f1e3" }, text: "hello" })).toBe(true);
    expect(accepts("type", "args", { target: { ref: "f1e3" } })).toBe(false);
  });

  it("bounds a snapshot at 200,000 characters, preset 30,000, with its filter, depth and focus", () => {
    expect(SNAPSHOT_MAX_CHARS).toEqual({ preset: 30_000, max: 200_000 });
    expect(accepts("snapshot", "args", {})).toBe(true);
    expect(accepts("snapshot", "args", { filter: "all", depth: 3, ref: "e4", maxChars: 200_000 })).toBe(true);
    expect(accepts("snapshot", "args", { maxChars: 200_001 })).toBe(false);
    expect(accepts("snapshot", "args", { filter: "visible" })).toBe(false);
    expect(accepts("snapshot", "value", { url: "https://example.com/", title: "Example", text: "- button \"Buy\" [ref=e1]", totalChars: 23, truncated: false })).toBe(true);
  });

  it("scrolls by a direction and an amount in viewports, or to a ref", () => {
    expect(accepts("scroll", "args", { to: { direction: "down" } })).toBe(true);
    expect(accepts("scroll", "args", { to: { direction: "up", amount: 2.5 } })).toBe(true);
    expect(accepts("scroll", "args", { to: { ref: "e9" } })).toBe(true);
    expect(accepts("scroll", "args", { to: { direction: "sideways" } })).toBe(false);
    expect(accepts("scroll", "args", { to: { direction: "down", ref: "e9" } })).toBe(false);
  });

  it("waits for text, a ref or a number of milliseconds, bounded at 30 seconds with 10 preset, a longer ask clamped rather than refused", () => {
    expect(WAIT_FOR_MS).toEqual({ preset: 10_000, max: 30_000 });
    expect(accepts("waitFor", "args", { until: { text: "Loaded", timeoutMs: 60_000 } })).toBe(true);
    expect(accepts("waitFor", "args", { until: { ref: "e3" } })).toBe(true);
    expect(accepts("waitFor", "args", { until: { ms: 500 } })).toBe(true);
    expect(accepts("waitFor", "args", { until: { text: "Loaded", ms: 500 } })).toBe(false);
    expect(waitBoundMs({ text: "Loaded" })).toBe(10_000);
    expect(waitBoundMs({ ref: "e3", timeoutMs: 2_000 })).toBe(2_000);
    expect(waitBoundMs({ text: "Loaded", timeoutMs: 60_000 })).toBe(30_000);
    expect(waitBoundMs({ ms: 500 })).toBe(500);
    expect(waitBoundMs({ ms: 45_000 })).toBe(30_000);
  });

  it("reads the page as paged Markdown, saying whether it read an article or the snapshot's text", () => {
    expect(accepts("read", "args", { offset: 24_000, links: true })).toBe(true);
    expect(accepts("read", "args", { offset: -1 })).toBe(false);
    const page = { url: "https://example.com/a", title: "A", source: "article", text: "# A", offset: 0, totalChars: 30_000, nextOffset: 24_000 };
    expect(accepts("read", "value", page)).toBe(true);
    expect(accepts("read", "value", { ...page, source: "snapshot", nextOffset: null, challenge: "turnstile" })).toBe(true);
    expect(accepts("read", "value", { ...page, source: "readability" })).toBe(false);
  });

  it("answers an action with where the page is, its snapshot when asked, and a challenge the page shows", () => {
    const arrival = { url: "https://example.com/", title: "Example" };
    expect(accepts("navigate", "value", arrival)).toBe(true);
    expect(accepts("click", "value", { ...arrival, snapshot: { text: "- link \"Next\" [ref=e2]", totalChars: 22, truncated: false }, challenge: "recaptcha" })).toBe(true);
    expect(accepts("click", "value", { ...arrival, challenge: "captcha" })).toBe(false);
    expect(accepts("screenshot", "value", { mimeType: "image/jpeg", data: "/9j/4AAQ" })).toBe(true);
    expect(accepts("screenshot", "value", { mimeType: "image/gif", data: "R0lG" })).toBe(false);
    expect(accepts("close", "value", null)).toBe(true);
  });

  it("answers the deep verbs as a developer reads them, a cookie's value only where it may be read", () => {
    const at = "2026-09-29T01:02:03.000Z";
    expect(accepts("console", "value", [{ level: "error", text: "Uncaught TypeError", source: "app.js:12", at }])).toBe(true);
    expect(accepts("network", "args", { failedOnly: true })).toBe(true);
    expect(accepts("network", "value", [{ method: "GET", url: "https://example.com/api", status: 500, resourceType: "fetch", durationMs: 12.5, at }])).toBe(true);
    expect(accepts("cookies", "value", [{ name: "session", domain: ".example.com", path: "/", httpOnly: true, secure: true, sameSite: "Lax" }])).toBe(true);
    expect(accepts("storage", "value", { origin: "http://localhost:3000", local: { theme: "dark" }, session: {} })).toBe(true);
    expect(accepts("evaluate", "args", { expression: "document.title" })).toBe(true);
    expect(accepts("evaluate", "value", { result: { a: [1, "two", null] } })).toBe(true);
    expect(accepts("evaluate", "value", {})).toBe(false);
  });

  it("carries a command as its verb and its arguments, and a call as the page key, the command and a one-time allowance", () => {
    const command = { verb: "navigate", args: { url: "https://www.paypal.com/" } };
    expect(PageCommand.safeParse(command).success).toBe(true);
    expect(PageCommand.safeParse({ verb: "focus", args: {} }).success).toBe(false);
    expect(PageCommand.safeParse({ verb: "navigate", args: { target: { ref: "e1" } } }).success).toBe(false);
    expect(PageCall.safeParse({ pageKey: "env/session", command, allowance: { host: "www.paypal.com" } }).success).toBe(true);
    expect(PageCall.safeParse({ pageKey: "", command }).success).toBe(false);
  });

  it("refuses with a sentence, carrying the denylist's match and the frame when the browser section refused an address", () => {
    const entry = denylistPresets("/data").browserDomains[5];
    const refusal = { ok: false, reason: "www.paypal.com is on the denylist (browser domains: *.paypal.com).", denylist: { frame: "top-level", match: { section: "browserDomains", entry, matched: "https://www.paypal.com/" } } };
    expect(PageRefusal.safeParse(refusal).success).toBe(true);
    expect(PageRefusal.safeParse({ ok: false, reason: "No element matches that selector." }).success).toBe(true);
    expect(PageRefusal.safeParse({ ok: false, reason: "" }).success).toBe(false);
    expect(PageRefusal.safeParse({ ...refusal, denylist: { ...refusal.denylist, frame: "iframe" } }).success).toBe(false);
    expect(PageOutcome.safeParse({ ok: true, value: { url: "https://example.com/", title: "" }, notice: "The wait was clamped to 30 seconds." }).success).toBe(true);
    expect(PageOutcome.safeParse(refusal).success).toBe(true);
    expect(PageOutcome.safeParse({ ok: true }).success).toBe(false);
    expect(PageOutcome.safeParse({ ok: false }).success).toBe(false);
  });
});
