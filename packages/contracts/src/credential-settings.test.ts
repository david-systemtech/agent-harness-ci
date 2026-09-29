import { describe, expect, it } from "vitest";
import { CREDENTIAL_SETTINGS_KEYS, SETTINGS, isGenericSettingsKey, presetSettings, settingForm, type SettingsKey } from "./index.js";

/**
 * The injection setting (key-managers spec, "Injection"; ADR 0011, ADR
 * 0028; #367): the environment's `credentials.injection` and the
 * per-account `credentials.injectionByAccount`, both on the Key manager
 * step's row in the Access band, written through `settings.update`.
 */

const accepts = (key: SettingsKey, value: unknown): boolean => SETTINGS[key].schema.safeParse(value).success;
const accountId = "0f8fad5b-d9cb-469f-a165-70867728950e";

describe("the injection settings", () => {
  it("are credentials.injection, preset allow, and credentials.injectionByAccount, preset empty, each written by the Key manager step on access.key-managers through settings.update", () => {
    expect(CREDENTIAL_SETTINGS_KEYS).toEqual(["credentials.injection", "credentials.injectionByAccount"]);
    const presets = presetSettings();
    expect(Object.fromEntries(CREDENTIAL_SETTINGS_KEYS.map((key) => [key, presets[key]]))).toEqual({
      "credentials.injection": "allow",
      "credentials.injectionByAccount": {},
    });
    for (const key of CREDENTIAL_SETTINGS_KEYS) {
      expect(SETTINGS[key].step, key).toEqual({ id: "key-manager", row: "access.key-managers" });
      expect(isGenericSettingsKey(key), key).toBe(true);
    }
  });

  it("takes allow or deny for the environment, which a generic editor offers as a choice", () => {
    expect(accepts("credentials.injection", "allow")).toBe(true);
    expect(accepts("credentials.injection", "deny")).toBe(true);
    for (const value of ["inherit", "Allow", null, true, ""]) expect(accepts("credentials.injection", value), String(value)).toBe(false);
    expect(settingForm("credentials.injection")).toEqual({ kind: "choice", options: ["allow", "deny"] });
  });

  it("takes allow or deny by account id, never inherit, which is an account left out", () => {
    expect(accepts("credentials.injectionByAccount", {})).toBe(true);
    expect(accepts("credentials.injectionByAccount", { [accountId]: "deny", "claude-max": "allow" })).toBe(true);
    for (const value of [{ [accountId]: "inherit" }, { [accountId]: null }, { "": "deny" }, ["deny"], "deny", null]) {
      expect(accepts("credentials.injectionByAccount", value), JSON.stringify(value)).toBe(false);
    }
  });
});
