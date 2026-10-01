import { describe, expect, it } from "vitest";
import {
  BRIDGE_PATH,
  BrowserStatus,
  ENVIRONMENT_NOTICE_TYPES,
  EnvironmentNotice,
  HeadlessBrowserStatus,
  bridgeUrl,
  eventTypeEntry,
  registry,
} from "./index.js";

/**
 * The environment's side of the extension (browser spec, "The extension,
 * its folder and its listener" and "Settings, methods, events and
 * notices"; #547): `browser.status`, the `extension.seen` notice, and where
 * the extension dials; and the headless browser's part of `browser.status`
 * (#555).
 */

const listening = { state: "listening", port: 47615 };
const folder = { path: "/home/david/.local/state/agent-harness/extension/current", problem: null };
const headless = { allowRuns: true, availability: { available: true, source: { kind: "launched", executable: "/usr/bin/chromium" } }, liveContexts: 0 };
const status = { listener: listening, folder, shippedVersion: "0.4.2", unpairedConnected: false, headless };

describe("browser.status", () => {
  it("is a query at read, the one scope every browser reading has, taking no params", () => {
    expect([registry["browser.status"].kind, registry["browser.status"].scope]).toEqual(["query", "read"]);
    expect(registry["browser.status"].params.parse({})).toEqual({});
  });

  it("answers the listener's port, the folder's path, the shipped version and whether an unpaired extension is connected", () => {
    expect(BrowserStatus.parse(status)).toEqual(status);
    expect(registry["browser.status"].result.parse({ ...status, unpairedConnected: true })).toMatchObject({ unpairedConnected: true });
  });

  it("answers the port-in-use error in the listener's place when no port of the range was free", () => {
    const refused = {
      ...status,
      listener: { state: "not-listening", reason: "port-in-use", message: "Ports 47615 to 47634 on loopback are all in use, so Chrome cannot reach this environment." },
    };
    expect(BrowserStatus.parse(refused)).toEqual(refused);
    expect(BrowserStatus.safeParse({ ...status, listener: { state: "not-listening", reason: "port-in-use" } }).success).toBe(false);
    expect(BrowserStatus.safeParse({ ...status, listener: { state: "listening" } }).success).toBe(false);
  });

  it("answers the folder's problem, and a null shipped version for an environment that carries no built extension", () => {
    const none = { ...status, folder: { ...folder, problem: "This environment carries no built extension." }, shippedVersion: null };
    expect(BrowserStatus.parse(none)).toEqual(none);
    expect(BrowserStatus.safeParse({ ...status, folder: { path: "" , problem: null } }).success).toBe(false);
    expect(BrowserStatus.safeParse({ ...status, shippedVersion: "" }).success).toBe(false);
  });
});

describe("browser.status's headless part", () => {
  it("answers the permission, the source of an available headless browser and its live contexts", () => {
    const endpoint = { ...headless, availability: { available: true, source: { kind: "endpoint", endpoint: "http://127.0.0.1:9222" } }, liveContexts: 2 };
    expect(BrowserStatus.parse({ ...status, headless: endpoint })).toEqual({ ...status, headless: endpoint });
    expect(HeadlessBrowserStatus.parse(headless)).toEqual(headless);
  });

  it("answers why there is none in the source's place, and the permission off beside either", () => {
    const absent = { allowRuns: false, availability: { available: false, reason: "No Chromium or Chrome was found." }, liveContexts: 0 };
    expect(HeadlessBrowserStatus.parse(absent)).toEqual(absent);
    expect(HeadlessBrowserStatus.safeParse({ ...absent, availability: { available: false, reason: "" } }).success).toBe(false);
    expect(HeadlessBrowserStatus.safeParse({ ...absent, availability: { available: false } }).success).toBe(false);
    expect(HeadlessBrowserStatus.safeParse({ ...headless, availability: { available: true } }).success).toBe(false);
  });

  it("names an endpoint by its CDP address and a launched browser by its executable, and counts live contexts from 0", () => {
    const sourced = (source: unknown) => HeadlessBrowserStatus.safeParse({ ...headless, availability: { available: true, source } }).success;
    expect(sourced({ kind: "endpoint", endpoint: "ws://127.0.0.1:9222/devtools/browser/abc" })).toBe(true);
    expect(sourced({ kind: "endpoint", endpoint: "ftp://127.0.0.1:9222" })).toBe(false);
    expect(sourced({ kind: "launched", executable: "" })).toBe(false);
    expect(sourced({ kind: "container" })).toBe(false);
    expect(HeadlessBrowserStatus.safeParse({ ...headless, liveContexts: -1 }).success).toBe(false);
    expect(BrowserStatus.safeParse({ ...status, headless: undefined }).success).toBe(false);
  });
});

describe("the extension.seen notice", () => {
  it("is on the environment stream, never in the session list: an unpaired extension opened its socket, with the versions it announced", () => {
    expect(ENVIRONMENT_NOTICE_TYPES).toContain("extension.seen");
    expect(eventTypeEntry("environment", "extension.seen")).toMatchObject({ list: false });
    const seen = { type: "extension.seen", payload: { protocolVersion: 2, extensionVersion: "0.4.2" } };
    expect(EnvironmentNotice.parse(seen)).toEqual(seen);
    expect(EnvironmentNotice.safeParse({ type: "extension.seen", payload: { protocolVersion: 2 } }).success).toBe(false);
  });
});

describe("where the extension dials", () => {
  it("is the listener's port on IPv4 loopback, at /bridge", () => {
    expect(BRIDGE_PATH).toBe("/bridge");
    expect(bridgeUrl(47616)).toBe("ws://127.0.0.1:47616/bridge");
  });
});
