import { describe, expect, it } from "vitest";
import { AUTO_SETTLE_KEYS, SETTINGS, STEP_REGISTRY, presetSettings, type SettingsKey } from "./index.js";

/**
 * The step registry's contract test (ADR 0016; session-state spec,
 * "Auto-settle: rules and settings"): every settings key names a
 * registered step that writes it and links to its band, and every step
 * writes only settings keys, each with a health check. The check is a plain
 * function over the two tables, so each failure it exists to catch is shown
 * failing on a table broken on purpose.
 */

/** A settings table as the check reads it, typed loosely so a broken one can be written. */
type LooseSettings = Readonly<Record<string, { readonly step: { readonly id: string; readonly band: string } }>>;

/** A step as the check reads it, typed loosely so a broken one can be written. */
interface LooseStep {
  readonly id: string;
  readonly writes: readonly string[];
  readonly checks: readonly { readonly key: string; readonly check: (value: unknown) => true | string }[];
  readonly links: readonly { readonly pane: string; readonly band: string }[];
}

/** What is wrong with the two tables together. */
const stepRegistryProblems = (settings: LooseSettings, steps: readonly LooseStep[]): string[] => {
  const problems: string[] = [];
  const ids = steps.map((step) => step.id);
  for (const id of new Set(ids)) if (ids.filter((other) => other === id).length > 1) problems.push(`${id}: registered twice`);
  for (const [key, { step: place }] of Object.entries(settings)) {
    const writers = steps.filter((step) => step.writes.includes(key)).map((step) => step.id);
    const named = steps.find((step) => step.id === place.id);
    if (named === undefined) problems.push(`${key}: names the step ${place.id}, which is not registered`);
    if (writers.length === 0) problems.push(`${key}: no step writes it`);
    else if (writers.length > 1) problems.push(`${key}: written by ${writers.join(", ")}`);
    else if (named !== undefined && writers[0] !== named.id) problems.push(`${key}: names ${named.id} but ${writers[0]} writes it`);
    if (named !== undefined && !named.links.some((link) => link.band === place.band)) {
      problems.push(`${key}: ${named.id} links to no ${place.band} band`);
    }
  }
  for (const step of steps) {
    for (const key of step.writes) {
      if (!Object.hasOwn(settings, key)) problems.push(`${step.id}: writes ${key}, which is not a setting`);
      if (step.checks.filter((check) => check.key === key).length !== 1) problems.push(`${step.id}: needs one health check of ${key}`);
    }
    for (const check of step.checks) {
      if (!step.writes.includes(check.key)) problems.push(`${step.id}: checks ${check.key}, which it does not write`);
    }
  }
  return problems;
};

const settings = SETTINGS as LooseSettings;
const steps = STEP_REGISTRY as readonly LooseStep[];
const [appearance, account] = steps as [LooseStep, LooseStep];

describe("the step registry", () => {
  it("has every settings key named by, written by and linked from one registered step, each written key checked", () => {
    expect(stepRegistryProblems(settings, steps)).toEqual([]);
  });

  it("puts both auto-settle keys under the Appearance entry's Sessions band", () => {
    expect(STEP_REGISTRY.map((step) => step.id)).toEqual(["appearance", "account"]);
    expect(appearance.writes).toEqual(["sessions.autoSettleAfterIdle", "sessions.autoSettleOnMerge"]);
    expect(appearance.links).toEqual([{ pane: "appearance", band: "sessions" }]);
    for (const key of AUTO_SETTLE_KEYS) expect(SETTINGS[key].step, key).toEqual({ id: "appearance", band: "sessions" });
  });

  it("puts providers.processIdleMinutes under the Account entry's Default model band, checked done on any valid value", () => {
    expect(account.writes).toEqual(["providers.processIdleMinutes"]);
    expect(account.links).toEqual([{ pane: "accounts", band: "default-model" }]);
    expect(SETTINGS["providers.processIdleMinutes"].step).toEqual({ id: "account", band: "default-model" });
    const check = (account.checks[0] as LooseStep["checks"][number]).check;
    expect(check(presetSettings()["providers.processIdleMinutes"])).toBe(true);
    expect(check(1440)).toBe(true);
    expect(check(0)).toMatch(/providers\.processIdleMinutes/);
  });

  it("fails when a settings key names no entry, or no entry writes it", () => {
    const added = { ...settings, "sessions.autoArchive": { step: { id: "housekeeping", band: "sessions" } } };
    expect(stepRegistryProblems(added, steps)).toEqual([
      "sessions.autoArchive: names the step housekeeping, which is not registered",
      "sessions.autoArchive: no step writes it",
    ]);
    const unwritten = { ...settings, "sessions.autoArchive": { step: { id: "appearance", band: "sessions" } } };
    expect(stepRegistryProblems(unwritten, steps)).toEqual(["sessions.autoArchive: no step writes it"]);
  });

  it("fails when a key is written by a step other than the one it names, or by two", () => {
    const other: LooseStep = { id: "permissions", writes: ["sessions.autoSettleOnMerge"], checks: [], links: [] };
    expect(stepRegistryProblems(settings, [{ ...appearance, writes: ["sessions.autoSettleAfterIdle"], checks: appearance.checks.slice(0, 1) }, other, account])).toEqual([
      "sessions.autoSettleOnMerge: names appearance but permissions writes it",
      "permissions: needs one health check of sessions.autoSettleOnMerge",
    ]);
    expect(stepRegistryProblems(settings, [appearance, { ...other, checks: [appearance.checks[1] as LooseStep["checks"][number]] }, account])).toEqual([
      "sessions.autoSettleOnMerge: written by appearance, permissions",
    ]);
  });

  it("fails when a step writes a key that is not a setting, writes a key it does not check, or links to no band a key sits in", () => {
    expect(stepRegistryProblems(settings, [{ ...appearance, writes: [...appearance.writes, "appearance.theme"] }, account])).toEqual([
      "appearance: writes appearance.theme, which is not a setting",
      "appearance: needs one health check of appearance.theme",
    ]);
    expect(stepRegistryProblems(settings, [{ ...appearance, checks: [] }, account])).toEqual([
      "appearance: needs one health check of sessions.autoSettleAfterIdle",
      "appearance: needs one health check of sessions.autoSettleOnMerge",
    ]);
    expect(stepRegistryProblems(settings, [{ ...appearance, links: [{ pane: "appearance", band: "theme" }] }, account])).toEqual([
      "sessions.autoSettleAfterIdle: appearance links to no sessions band",
      "sessions.autoSettleOnMerge: appearance links to no sessions band",
    ]);
    expect(stepRegistryProblems(settings, [appearance, appearance, account])).toEqual([
      "appearance: registered twice",
      "sessions.autoSettleAfterIdle: written by appearance, appearance",
      "sessions.autoSettleOnMerge: written by appearance, appearance",
    ]);
  });

  it("checks each auto-settle key done on any valid value, the preset included, and names the key when it is not", () => {
    const check = (key: SettingsKey) => (appearance.checks.find((entry) => entry.key === key) as LooseStep["checks"][number]).check;
    const presets = presetSettings();
    for (const key of AUTO_SETTLE_KEYS) expect(check(key)(presets[key]), key).toBe(true);
    for (const value of [null, { amount: 1, unit: "days" }, { amount: 3, unit: "weeks" }, { amount: 1000, unit: "months" }]) {
      expect(check("sessions.autoSettleAfterIdle")(value), JSON.stringify(value)).toBe(true);
    }
    expect(check("sessions.autoSettleOnMerge")(true)).toBe(true);
    expect(check("sessions.autoSettleAfterIdle")({ amount: 0, unit: "days" })).toMatch(/sessions\.autoSettleAfterIdle/);
    expect(check("sessions.autoSettleOnMerge")("yes")).toMatch(/sessions\.autoSettleOnMerge/);
  });
});
