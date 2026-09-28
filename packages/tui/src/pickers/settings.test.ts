import { describe, expect, it } from "vitest";
import { parseTyped, valueWords, writerOf } from "./settings.js";

/** `/settings`, the generic editor's pure half (docs/specs/tui.md, "Status, usage, pickers"; #147). */

describe("a setting's value in words", () => {
  it("says a switch, none, an amount of a unit, a word or a number as a person reads them", () => {
    expect([valueWords(true), valueWords(false), valueWords(null)]).toEqual(["on", "off", "none"]);
    expect(valueWords({ amount: 14, unit: "days" })).toBe("14 days");
    expect(valueWords({ amount: 1, unit: "days" })).toBe("1 day");
    expect([valueWords("acceptEdits"), valueWords(30), valueWords("never")]).toEqual(["acceptEdits", "30", "never"]);
    expect(valueWords({ amount: 1, unit: "days", extra: true })).toBe('{"amount":1,"unit":"days","extra":true}');
  });
});

describe("the method that writes a key", () => {
  it("is settings.update for a generic key, permissions.settings.set for a permission key, updates.settings.set for an update key, and nothing for the acknowledgement's time", () => {
    expect(writerOf("providers.processIdleMinutes")).toBe("settings.update");
    expect(writerOf("permissions.defaultCeiling")).toBe("permissions.settings.set");
    expect(writerOf("updates.channel")).toBe("updates.settings.set");
    expect(writerOf("updates.pinnedVersion")).toBe("updates.settings.set");
    expect(writerOf("permissions.unattended.bypassAcknowledgedAt")).toBeNull();
  });
});

describe("a typed value", () => {
  it("reads JSON, a bare word, an amount and a unit, and none for null where the key takes it", () => {
    expect(parseTyped("providers.processIdleMinutes", " 45 ")).toEqual({ ok: true, value: 45 });
    expect(parseTyped("accounts.defaultModelFamily", "opus")).toEqual({ ok: true, value: "opus" });
    expect(parseTyped("accounts.defaultModelFamily", "none")).toEqual({ ok: true, value: null });
    expect(parseTyped("accounts.defaultModelFamily", '"none"')).toEqual({ ok: true, value: "none" });
    expect(parseTyped("sessions.autoSettleAfterIdle", "2 weeks")).toEqual({ ok: true, value: { amount: 2, unit: "weeks" } });
    expect(parseTyped("sessions.autoSettleAfterIdle", "1 day")).toEqual({ ok: true, value: { amount: 1, unit: "days" } });
    expect(parseTyped("permissions.parkedPrompt.ttl", "never")).toEqual({ ok: true, value: "never" });
    expect(parseTyped("permissions.parkedPrompt.ttl", '{"amount": 3, "unit": "hours"}')).toEqual({ ok: true, value: { amount: 3, unit: "hours" } });
  });

  it("names the key and the schema's objection when the key does not take it", () => {
    const refused = parseTyped("providers.processIdleMinutes", "5000");
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.line).toMatch(/^providers\.processIdleMinutes: .*1440/);
    expect(parseTyped("providers.processIdleMinutes", "  ")).toEqual({ ok: false, line: "providers.processIdleMinutes takes a value; type one, or Esc to leave it." });
    expect(parseTyped("sessions.transcriptCompactAfterDays", "none").ok).toBe(false);
  });
});
