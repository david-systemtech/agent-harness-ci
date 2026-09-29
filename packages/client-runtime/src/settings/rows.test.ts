import { SETTINGS_ADDRESSES, SETTINGS_ROW_IDS } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { matchSettingsRows, parseSettingsLink, rowSteps, settingsDeepLink, settingsRowNamed } from "./rows.js";

/**
 * Settings' rows as every renderer finds and opens them (docs/specs/gui.md,
 * "Settings: the rail, the rows and the addresses"; ADR 0027): search over
 * a row's id, label, hint and old names, a row named by an existing address
 * or its id, the deep link that opens one, and the steps a row links to.
 */

describe("search over the rows", () => {
  it("finds a row by its old names: secrets finds Key managers, cerebro Memory banks, profiles Accounts", () => {
    expect(matchSettingsRows("secrets")).toEqual(["access.key-managers"]);
    expect(matchSettingsRows("cerebro")).toEqual(["knowledge.banks"]);
    expect(matchSettingsRows("Profiles")).toEqual(["accounts.accounts"]);
  });

  it("finds by id, label and hint, every word typed in one of them, ignoring case, in the rail's order", () => {
    expect(matchSettingsRows("knowledge.skills")).toEqual(["knowledge.skills"]);
    expect(matchSettingsRows("KEYBOARD")).toEqual(["appearance.shortcuts"]);
    expect(matchSettingsRows("program pairings")).toEqual(["environments.access"]);
    expect(matchSettingsRows("advanced")).toEqual(["environments.machines", "environments.service"]);
    expect(matchSettingsRows("nothing is called this")).toEqual([]);
  });

  it("lists every row for an empty query", () => {
    expect(matchSettingsRows("  ")).toEqual(SETTINGS_ROW_IDS);
  });
});

describe("a row named", () => {
  it("by each of the sixteen addresses is the row the address table maps it to", () => {
    expect(Object.fromEntries(SETTINGS_ADDRESSES.map((address) => [address, settingsRowNamed(address)]))).toEqual({
      profiles: "accounts.accounts",
      models: "accounts.default-model",
      runs: "accounts.usage",
      agents: "knowledge.instructions",
      skills: "knowledge.skills",
      "memory-banks": "knowledge.banks",
      cerebro: "knowledge.banks",
      permissions: "access.permissions",
      browser: "access.browser",
      secrets: "access.key-managers",
      server: "environments.access",
      remote: "environments.machines",
      routines: "routines.routines",
      advanced: "environments.machines",
      appearance: "appearance.theme",
      about: "about.about",
    });
  });

  it("by its id is the row, ignoring case and the space around it; anything else names none", () => {
    expect(settingsRowNamed(" Access.Forges ")).toBe("access.forges");
    expect(settingsRowNamed("SECRETS")).toBe("access.key-managers");
    expect(settingsRowNamed("access.nothing")).toBeUndefined();
    expect(settingsRowNamed("")).toBeUndefined();
  });
});

describe("a settings deep link", () => {
  it("names an address or a row id after agent-harness://settings/, and opens its row", () => {
    expect(settingsDeepLink("secrets")).toBe("agent-harness://settings/secrets");
    expect(parseSettingsLink("agent-harness://settings/secrets")).toEqual({ row: "access.key-managers" });
    expect(parseSettingsLink("agent-harness://settings/knowledge.banks")).toEqual({ row: "knowledge.banks" });
    expect(parseSettingsLink("AGENT-HARNESS://Settings/Cerebro/")).toEqual({ row: "knowledge.banks" });
  });

  it("naming nothing opens the last row opened, and naming a row this build does not hold opens Set up", () => {
    expect(parseSettingsLink("agent-harness://settings")).toEqual({ row: null });
    expect(parseSettingsLink("agent-harness://settings/")).toEqual({ row: null });
    expect(parseSettingsLink("agent-harness://settings/a-newer-row")).toEqual({ row: "setup.checklist" });
  });

  it("is none for any other link", () => {
    expect(parseSettingsLink("agent-harness://pair?link=http%3A%2F%2Fdesk%3A7433%2Fpair%23K7Q2M-XH4RT")).toBeUndefined();
    expect(parseSettingsLink("https://example.com/settings/secrets")).toBeUndefined();
    expect(parseSettingsLink("agent-harness://settingsfoo")).toBeUndefined();
  });
});

describe("the steps a row links to", () => {
  it("are the steps it is home to, then those whose keys it holds or that link it", () => {
    expect(rowSteps("accounts.accounts")).toEqual(["account", "carry-over"]);
    expect(rowSteps("accounts.default-model")).toEqual(["account"]);
    expect(rowSteps("environments.service")).toEqual(["your-machines"]);
    expect(rowSteps("access.permissions")).toEqual(["permissions"]);
    expect(rowSteps("knowledge.banks")).toEqual(["memory-bank"]);
  });

  it("are none on a row no step lives on, and none on Set up, which is home to the whole checklist", () => {
    expect(rowSteps("accounts.usage")).toEqual([]);
    expect(rowSteps("setup.checklist")).toEqual([]);
  });
});
