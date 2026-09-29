import { describe, expect, it } from "vitest";
import { BROWSER_SETTINGS_KEYS, SETTINGS, isGenericSettingsKey, presetSettings, settingForm, type SettingsKey } from "./index.js";

/**
 * The `browser.*` settings (browser spec, "Settings, methods, events and
 * notices"; ADR 0024, ADR 0027; #541): each key's schema and preset, all on
 * the Browser step's row in the Access band.
 */

const accepts = (key: SettingsKey, value: unknown): boolean => SETTINGS[key].schema.safeParse(value).success;
const environmentId = "0f8fad5b-d9cb-469f-a165-70867728950e";
const chromeId = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

describe("the browser settings", () => {
  it("are the spec's nine keys with their presets, each written by the Browser step on access.browser through settings.update", () => {
    expect(BROWSER_SETTINGS_KEYS).toEqual([
      "browser.devSites",
      "browser.evaluateEverywhere",
      "browser.deepReadEverywhere",
      "browser.reach",
      "browser.headless.allowRuns",
      "browser.headless.endpoint",
      "browser.headless.executable",
      "browser.headless.limits",
      "browser.internalHosts",
    ]);
    const presets = presetSettings();
    expect(Object.fromEntries(BROWSER_SETTINGS_KEYS.map((key) => [key, presets[key]]))).toEqual({
      "browser.devSites": [],
      "browser.evaluateEverywhere": false,
      "browser.deepReadEverywhere": false,
      "browser.reach": {},
      "browser.headless.allowRuns": true,
      "browser.headless.endpoint": null,
      "browser.headless.executable": null,
      "browser.headless.limits": { maxContexts: 2, idleMinutes: 10, tabHeapMb: 500, exitMinutes: 5 },
      "browser.internalHosts": ["localhost", "127.0.0.1", "::1"],
    });
    for (const key of BROWSER_SETTINGS_KEYS) {
      expect(SETTINGS[key].step, key).toEqual({ id: "browser", row: "access.browser" });
      expect(isGenericSettingsKey(key), key).toBe(true);
    }
  });

  it("has no browser.blockedSites or browser.allowedDefaults: the denylist's browser section holds both", () => {
    expect(Object.keys(SETTINGS).filter((key) => key === "browser.blockedSites" || key === "browser.allowedDefaults")).toEqual([]);
  });

  it("takes host patterns for dev sites and internal hosts, as the denylist writes them", () => {
    for (const key of ["browser.devSites", "browser.internalHosts"] as const) {
      expect(accepts(key, ["localhost", "*.myapp.test", "192.168.1.10", "::1", "staging.example.com"]), key).toBe(true);
      expect(accepts(key, ["https://myapp.test"]), key).toBe(false);
      expect(accepts(key, ["myapp.test:3000"]), key).toBe(false);
      expect(accepts(key, ["*"]), key).toBe(false);
      expect(accepts(key, "localhost"), key).toBe(false);
    }
  });

  it("takes each account's reach by account id: per-session, or a Chrome of an environment, a null Chrome being the plain My Chrome", () => {
    expect(accepts("browser.reach", {})).toBe(true);
    expect(accepts("browser.reach", { "acc-1": "per-session", "acc-2": { chrome: { environmentId, chromeId } }, "acc-3": { chrome: { environmentId, chromeId: null } } })).toBe(true);
    expect(accepts("browser.reach", { "acc-1": "headless" })).toBe(false);
    expect(accepts("browser.reach", { "acc-1": { chrome: { environmentId } } })).toBe(false);
    expect(accepts("browser.reach", { "acc-1": { chrome: { environmentId: "desktop", chromeId: null } } })).toBe(false);
    expect(accepts("browser.reach", { "": "per-session" })).toBe(false);
  });

  it("names the headless browser's endpoint as a CDP address and its executable as a path, each null for none", () => {
    for (const value of [null, "http://browser:9222", "ws://127.0.0.1:9222/devtools/browser/abc", "wss://chromium.example.com/cdp"]) expect(accepts("browser.headless.endpoint", value), String(value)).toBe(true);
    for (const value of ["", "browser:9222", "ftp://browser:9222", "http://"]) expect(accepts("browser.headless.endpoint", value), value).toBe(false);
    for (const value of [null, "/usr/bin/chromium", "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"]) expect(accepts("browser.headless.executable", value), String(value)).toBe(true);
    expect(accepts("browser.headless.executable", "")).toBe(false);
  });

  it("holds the tab rules' limits at 1 or more each, so no rule can be switched off", () => {
    const limits = { maxContexts: 2, idleMinutes: 10, tabHeapMb: 500, exitMinutes: 5 };
    expect(accepts("browser.headless.limits", { maxContexts: 1, idleMinutes: 1, tabHeapMb: 1, exitMinutes: 1 })).toBe(true);
    for (const field of Object.keys(limits)) {
      expect(accepts("browser.headless.limits", { ...limits, [field]: 0 }), field).toBe(false);
      expect(accepts("browser.headless.limits", { ...limits, [field]: null }), field).toBe(false);
      expect(accepts("browser.headless.limits", { ...limits, [field]: 1.5 }), field).toBe(false);
    }
    expect(accepts("browser.headless.limits", { maxContexts: 2 })).toBe(false);
  });

  it("gives the two switches and allowRuns a switch in a generic editor, and the rest text", () => {
    for (const key of ["browser.evaluateEverywhere", "browser.deepReadEverywhere", "browser.headless.allowRuns"] as const) expect(settingForm(key), key).toEqual({ kind: "switch" });
    expect(settingForm("browser.headless.endpoint")).toEqual({ kind: "text", nullable: true });
    expect(settingForm("browser.headless.limits")).toEqual({ kind: "text", nullable: false });
  });
});
