import { describe, expect, it } from "vitest";
import {
  CHROME_EVENT_TYPES,
  CHROME_NAME_MAX,
  CHROME_PAIRING_CODE_LENGTH,
  CHROME_PAIRING_GUESSES,
  CHROME_PAIRING_TTL_MS,
  CHROME_STREAM_KIND,
  ENVIRONMENT_NOTICE_TYPES,
  EVENT_TYPES,
  EnvironmentNotice,
  PAIRING_CODE_ALPHABET,
  PairedChrome,
  UNNAMED_CHROME,
  chromeNameOf,
  eventTypeEntry,
  methods,
  normaliseChromePairingCode,
  registry,
} from "./index.js";

/**
 * Pairing and paired Chromes (browser spec, "The extension, its folder and
 * its listener" and "Settings, methods, events and notices"; ADR 0014, ADR
 * 0024; #548): the pairing code's rules, a paired Chrome's name, the
 * `chrome` stream, the list, rename and unpair methods, and the
 * `chrome.updated` notice.
 */

const chromeId = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const chrome = {
  id: chromeId,
  name: "Work",
  pairedAt: "2026-09-24T00:00:00.000Z",
  lastConnectedAt: "2026-09-24T00:05:00.000Z",
  lastReportedVersion: "0.4.2",
  connected: true,
  outdated: false,
};

describe("the browser methods", () => {
  it("each have one scope: the status and the list at read, the code, rename and unpair at admin, perform at runs:drive", () => {
    const browserMethods = methods.filter((method) => method.name.startsWith("browser."));
    expect(Object.fromEntries(browserMethods.map((method) => [method.name, [method.kind, method.scope]]))).toEqual({
      "browser.status": ["query", "read"],
      "browser.pairing.code": ["query", "admin"],
      "browser.chromes.list": ["query", "read"],
      "browser.chromes.rename": ["command", "admin"],
      "browser.chromes.unpair": ["command", "admin"],
      "browser.chromes.perform": ["query", "runs:drive"],
    });
  });

  it("answer the live pairing code with its expiry, eight characters of the pairing alphabet", () => {
    const result = registry["browser.pairing.code"].result;
    expect(result.parse({ code: "K7Q2MXH4", expiresAt: "2026-09-24T00:05:00.000Z" })).toEqual({ code: "K7Q2MXH4", expiresAt: "2026-09-24T00:05:00.000Z" });
    for (const code of ["K7Q2MXH", "K7Q2MXH4R", "K7Q2MXH1", "k7q2mxh4", "K7Q2-MXH4"]) {
      expect(result.safeParse({ code, expiresAt: "2026-09-24T00:05:00.000Z" }).success, code).toBe(false);
    }
    expect(registry["browser.pairing.code"].params.parse({})).toEqual({});
  });

  it("list each paired Chrome with whether it is connected and whether it runs another version than the folder's", () => {
    expect(registry["browser.chromes.list"].result.parse({ chromes: [chrome] })).toEqual({ chromes: [chrome] });
    expect(PairedChrome.safeParse({ ...chrome, connected: undefined }).success).toBe(false);
    expect(PairedChrome.safeParse({ ...chrome, name: "" }).success).toBe(false);
    expect(PairedChrome.safeParse({ ...chrome, id: "work" }).success).toBe(false);
  });

  it("rename a Chrome by its id and a name the environment cleans, and unpair one by its id, each answering the Chrome", () => {
    const commandId = "5b2d0c1e-8f0a-4d5c-9e3b-2a1f0c9d8e7b";
    expect(registry["browser.chromes.rename"].params.parse({ commandId, chromeId, name: "  Personal  " })).toEqual({ commandId, chromeId, name: "  Personal  " });
    expect(registry["browser.chromes.rename"].params.safeParse({ commandId, chromeId }).success).toBe(false);
    expect(registry["browser.chromes.unpair"].params.parse({ commandId, chromeId })).toEqual({ commandId, chromeId });
    expect(registry["browser.chromes.unpair"].params.safeParse({ commandId }).success).toBe(false);
    expect(registry["browser.chromes.rename"].result.parse({ chrome })).toEqual({ chrome });
    expect(registry["browser.chromes.unpair"].result.parse({ chrome })).toEqual({ chrome });
  });
});

describe("browser.chromes.perform", () => {
  const call = { pageKey: `env/${chromeId}`, command: { verb: "click", args: { target: { ref: "e12" } } } };

  it("takes a Chrome, or null for the plain My Chrome, with the page key, the verb and its arguments, and a one-time allowance", () => {
    const params = registry["browser.chromes.perform"].params;
    expect(params.parse({ chromeId, ...call })).toEqual({ chromeId, ...call });
    expect(params.parse({ chromeId: null, ...call, allowance: { host: "www.paypal.com" } })).toEqual({ chromeId: null, ...call, allowance: { host: "www.paypal.com" } });
    expect(params.safeParse(call).success).toBe(false);
    expect(params.safeParse({ chromeId: "work", ...call }).success).toBe(false);
    expect(params.safeParse({ chromeId, ...call, command: { verb: "focus", args: {} } }).success).toBe(false);
    expect(params.safeParse({ chromeId, ...call, command: { verb: "click", args: {} } }).success).toBe(false);
  });

  it("answers the extension's value or its refusal, as the outcome", () => {
    const result = registry["browser.chromes.perform"].result;
    const value = { ok: true, value: { url: "https://example.com/", title: "Example" } };
    expect(result.parse({ outcome: value })).toEqual({ outcome: value });
    expect(result.parse({ outcome: { ok: false, reason: "The Chrome Work is not connected." } })).toEqual({ outcome: { ok: false, reason: "The Chrome Work is not connected." } });
    expect(result.safeParse({ outcome: { ok: false } }).success).toBe(false);
    expect(result.safeParse(value).success).toBe(false);
  });
});

describe("the pairing code", () => {
  it("is eight characters of the pairing alphabet, good for five minutes, void after five wrong guesses", () => {
    expect(CHROME_PAIRING_CODE_LENGTH).toBe(8);
    expect(CHROME_PAIRING_TTL_MS).toBe(5 * 60 * 1000);
    expect(CHROME_PAIRING_GUESSES).toBe(5);
    expect(PAIRING_CODE_ALPHABET).toBe("23456789ABCDEFGHJKMNPQRSTVWXYZ");
  });

  it("is read as typed in any case, with spaces and hyphens ignored, and is nothing when what is left is not a code", () => {
    expect(normaliseChromePairingCode("k7q2-mxh4")).toBe("K7Q2MXH4");
    expect(normaliseChromePairingCode(" K7Q2 MXH4 ")).toBe("K7Q2MXH4");
    for (const typed of ["K7Q2MXH", "K7Q2MXH4R", "K7Q2MXH1", "K7Q2MXHO", ""]) expect(normaliseChromePairingCode(typed), typed).toBeUndefined();
  });
});

describe("a paired Chrome's name", () => {
  it("is trimmed, with control and invisible characters removed", () => {
    expect(chromeNameOf("  Work  ")).toBe("Work");
    expect(chromeNameOf("Wo\u0000r\u0007k")).toBe("Work");
    expect(chromeNameOf("Per​so‍nal ")).toBe("Personal");
    expect(chromeNameOf("‮Work⁦")).toBe("Work");
    expect(chromeNameOf("﻿ Work ­")).toBe("Work");
  });

  it("is at most 80 characters, never cut inside a character written as two code units", () => {
    expect(CHROME_NAME_MAX).toBe(80);
    expect(chromeNameOf("a".repeat(100))).toBe("a".repeat(80));
    expect(chromeNameOf(`${"a".repeat(79)}😀`)).toBe("a".repeat(79));
    expect(chromeNameOf(`${"a".repeat(78)}😀`)).toBe(`${"a".repeat(78)}😀`);
    expect(chromeNameOf(`${"a".repeat(79)}  b`)).toBe("a".repeat(79));
  });

  it("is A browser when nothing is left", () => {
    expect(UNNAMED_CHROME).toBe("A browser");
    for (const typed of ["", "   ", "​​", "\u0000\t\n"]) expect(chromeNameOf(typed), JSON.stringify(typed)).toBe("A browser");
  });
});

describe("the chrome stream", () => {
  it("carries chrome.paired, chrome.renamed, chrome.version-reported and chrome.unpaired, in the event-type table and never in the session list", () => {
    expect(CHROME_STREAM_KIND).toBe("chrome");
    expect(Object.keys(CHROME_EVENT_TYPES)).toEqual(["chrome.paired", "chrome.renamed", "chrome.version-reported", "chrome.unpaired"]);
    expect(EVENT_TYPES.chrome).toBe(CHROME_EVENT_TYPES);
    for (const type of Object.keys(CHROME_EVENT_TYPES)) expect(eventTypeEntry("chrome", type), type).toMatchObject({ list: false });
  });

  it("records a pairing's name and the version the extension announced, a rename's name and a reported version, and never a secret", () => {
    const paired = CHROME_EVENT_TYPES["chrome.paired"].payload;
    expect(paired.parse({ name: "Work", extensionVersion: "0.4.2" })).toEqual({ name: "Work", extensionVersion: "0.4.2" });
    expect(paired.parse({ name: "Work", extensionVersion: "0.4.2", secret: "a".repeat(64) })).toEqual({ name: "Work", extensionVersion: "0.4.2" });
    expect(paired.safeParse({ name: "", extensionVersion: "0.4.2" }).success).toBe(false);
    expect(CHROME_EVENT_TYPES["chrome.renamed"].payload.parse({ name: "Personal" })).toEqual({ name: "Personal" });
    expect(CHROME_EVENT_TYPES["chrome.renamed"].payload.safeParse({ name: "x".repeat(81) }).success).toBe(false);
    expect(CHROME_EVENT_TYPES["chrome.version-reported"].payload.parse({ extensionVersion: "0.4.3" })).toEqual({ extensionVersion: "0.4.3" });
    expect(CHROME_EVENT_TYPES["chrome.unpaired"].payload.parse({})).toEqual({});
  });
});

describe("the chrome.updated notice", () => {
  it("is on the environment stream, never in the session list, naming the Chrome and what changed", () => {
    expect(ENVIRONMENT_NOTICE_TYPES).toContain("chrome.updated");
    expect(eventTypeEntry("environment", "chrome.updated")).toMatchObject({ list: false });
    for (const change of ["paired", "renamed", "unpaired", "connected", "disconnected", "version"]) {
      const notice = { type: "chrome.updated", payload: { chromeId, name: "Work", change } };
      expect(EnvironmentNotice.parse(notice), change).toEqual(notice);
    }
    expect(EnvironmentNotice.safeParse({ type: "chrome.updated", payload: { chromeId, name: "Work", change: "proved" } }).success).toBe(false);
    expect(EnvironmentNotice.safeParse({ type: "chrome.updated", payload: { chromeId, change: "paired" } }).success).toBe(false);
  });
});
