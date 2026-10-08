import { describe, expect, it } from "vitest";
import { BYPASS_SENTENCE, type CommandReceipt } from "@agent-harness/contracts";
import { confirmationOf, describeKey, noKeysLine, parseTyped, rowKeys, saveSetting, valueWords, writerOf } from "./editor.js";

/**
 * The generic settings editor both renderers draw (docs/specs/tui.md,
 * "Status, usage, pickers"; #147; docs/specs/gui.md, "Settings: the rail,
 * the rows and the addresses"; #412): a row's keys, a value in words, a typed
 * value read as the key's, and a key written through the method that writes it.
 */

describe("a row's keys", () => {
  it("are the keys the table places on it, in the table's order, and a row holding none says so", () => {
    expect(rowKeys("accounts.default-model")).toEqual(["accounts.defaultAccount", "accounts.defaultModelFamily", "accounts.defaultEffort", "accounts.favouriteModels", "providers.processIdleMinutes"]);
    expect(rowKeys("environments.service")).toEqual(["sessions.autoSettleAfterIdle", "sessions.autoSettleOnMerge", "sessions.transcriptCompactAfterDays"]);
    expect(rowKeys("knowledge.banks")).toEqual([]);
    expect(noKeysLine("knowledge.banks")).toBe("Memory banks holds no settings key.");
  });
});

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

/** A runtime whose direct requests answer `answer`, recording what was sent. */
const requesting = (answer: unknown) => {
  const sent: unknown[] = [];
  const runtime = {
    requests: {
      call: async (environmentId: string, method: string, params: unknown) => {
        sent.push({ environmentId, method, params });
        return answer;
      },
    },
  } as unknown as Parameters<typeof saveSetting>[0];
  return { runtime, sent };
};

const accepted: CommandReceipt = { status: "accepted", sequence: 4, changed: true };

describe("a value confirmed before it is written", () => {
  it("is the unattended mode's bypassPermissions, with its one sentence (ADR 0006); no other value is", () => {
    expect(confirmationOf("permissions.unattended.mode", "bypassPermissions")).toMatchObject({ sentence: BYPASS_SENTENCE, acknowledgement: "acknowledgeBypass" });
    expect(confirmationOf("permissions.unattended.mode", "acceptEdits")).toBeUndefined();
    expect(confirmationOf("permissions.defaultCeiling", "bypassPermissions")).toBeUndefined();
  });
});

describe("saving a key", () => {
  it("sends it through the method that writes it, as an admin request with its command id, and answers the values the environment holds after", async () => {
    const generic = requesting({ ok: true, result: { receipt: accepted, result: { values: { "providers.processIdleMinutes": 45 } } } });
    expect(await saveSetting(generic.runtime, "env-a", "providers.processIdleMinutes", 45, { commandId: "c-1" })).toEqual({ ok: true, values: { "providers.processIdleMinutes": 45 } });
    expect(generic.sent).toEqual([{ environmentId: "env-a", method: "settings.update", params: { commandId: "c-1", values: { "providers.processIdleMinutes": 45 } } }]);

    const update = requesting({ ok: true, result: { receipt: accepted, result: { values: { "updates.channel": "beta" } } } });
    await saveSetting(update.runtime, "env-a", "updates.channel", "beta", { commandId: "c-2", acknowledgeBypass: true });
    expect(update.sent).toEqual([{ environmentId: "env-a", method: "updates.settings.set", params: { commandId: "c-2", values: { "updates.channel": "beta" } } }]);

    const permission = requesting({ ok: true, result: { receipt: accepted, result: { values: { "permissions.unattended.mode": "bypassPermissions" } } } });
    await saveSetting(permission.runtime, "env-a", "permissions.unattended.mode", "bypassPermissions", { commandId: "c-3", acknowledgeBypass: true });
    expect(permission.sent).toEqual([
      { environmentId: "env-a", method: "permissions.settings.set", params: { commandId: "c-3", values: { "permissions.unattended.mode": "bypassPermissions" }, acknowledgeBypass: true } },
    ]);
  });

  it("answers the value sent when a retry is answered by its stored receipt, which carries no result", async () => {
    const { runtime } = requesting({ ok: true, result: { receipt: { ...accepted, changed: false } } });
    expect(await saveSetting(runtime, "env-a", "sessions.autoSettleOnMerge", true, { commandId: "c-1" })).toEqual({ ok: true, values: { "sessions.autoSettleOnMerge": true } });
  });

  it("says in one line why not: the request's failure, the receipt's rejection, or a key nothing writes", async () => {
    const refused = requesting({ ok: false, error: { code: "scope", message: "This app has limited access to desk, so it cannot change settings or sign in accounts. Pair again with full access to change this." } });
    expect(await saveSetting(refused.runtime, "env-a", "sessions.autoSettleOnMerge", true, { commandId: "c-1" })).toEqual({
      ok: false,
      line: "This app has limited access to desk, so it cannot change settings or sign in accounts. Pair again with full access to change this.",
    });
    const rejected = requesting({ ok: true, result: { receipt: { status: "rejected", sequence: 4, changed: false, reason: "invalid_params", error: { code: "invalid_params", message: "Not a channel." } } } });
    expect(await saveSetting(rejected.runtime, "env-a", "updates.channel", "nightly", { commandId: "c-1" })).toEqual({ ok: false, line: "Not a channel." });
    const none = requesting({ ok: true });
    expect(await saveSetting(none.runtime, "env-a", "permissions.unattended.bypassAcknowledgedAt", null, { commandId: "c-1" })).toEqual({
      ok: false,
      line: "permissions.unattended.bypassAcknowledgedAt is recorded by the environment itself; nothing sets it.",
    });
    expect(none.sent).toEqual([]);
  });
});

it("describes a setting in words for both editors", () => {
  expect(describeKey("sessions.autoSettleAfterIdle")).toBe("Move quiet sessions out of the active list after this long. Choose none to keep them active until you settle them yourself.");
  expect(describeKey("browser.headless.endpoint")).not.toMatch(/browser\.headless|\bnull\b/);
});
