import { describe, expect, it } from "vitest";
import {
  AUTO_SETTLE_KEYS,
  BYPASS_SENTENCE,
  DENYLIST_SECTIONS,
  PERMISSION_SETTINGS_KEYS,
  SETTINGS,
  SETUP_ACTIONS,
  STEP_ORDER,
  STEP_REGISTRY,
  isMethodName,
  presetSettings,
  type SettingsKey,
} from "./index.js";

/**
 * The step registry's contract test (ADR 0016; session-state spec,
 * "Auto-settle: rules and settings"): every settings key names a
 * registered step that writes it and links to its band, and every step
 * writes only settings keys, each with a health check; the steps stand in
 * the milestone-1 order, link only to steps of it, write state only through
 * registered methods, confirm only keys they write, and name their state
 * checks for themselves (#141). The Permissions entry names every settings
 * key the permissions spec writes and the denylist's four sections. Each
 * check is a plain function over the tables, so each failure it exists to
 * catch is shown failing on a table broken on purpose.
 */

/** A settings table as the check reads it, typed loosely so a broken one can be written. */
type LooseSettings = Readonly<Record<string, { readonly step: { readonly id: string; readonly band: string } }>>;

/** A step as the check reads it, typed loosely so a broken one can be written. */
interface LooseStep {
  readonly id: string;
  readonly writes: readonly string[];
  readonly writesState?: readonly { readonly method: string; readonly parts: readonly string[] }[];
  readonly confirms?: readonly { readonly key: string; readonly value: unknown; readonly sentence: string; readonly acknowledgement: string; readonly records: string }[];
  readonly checks: readonly { readonly key: string; readonly check: (value: unknown) => true | string }[];
  readonly stateChecks: readonly { readonly id: string; readonly holds: string; readonly actions: readonly string[] }[];
  readonly links: readonly ({ readonly pane: string; readonly band: string } | { readonly step: string })[];
  readonly skippable: boolean;
}

/** The pane links of a step, without its links to other steps. */
const paneLinks = (step: LooseStep) => step.links.filter((link): link is { pane: string; band: string } => "pane" in link);

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
    if (named !== undefined && !paneLinks(named).some((link) => link.band === place.band)) {
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

/**
 * What else is wrong with the steps (#141): a step outside the milestone-1
 * order or out of it, a link to a step that is not in the order or to
 * itself, state written through a method that is not registered, a
 * confirmation of a key the step does not write, a state check not named
 * `<step>.<what>` or named twice, or an action outside ADR 0031's vocabulary.
 */
const stepShapeProblems = (steps: readonly LooseStep[]): string[] => {
  const problems: string[] = [];
  const order = STEP_ORDER as readonly string[];
  const positions = steps.map((step) => order.indexOf(step.id));
  steps.forEach((step, index) => {
    if (positions[index] === -1) problems.push(`${step.id}: not a step of the milestone-1 order`);
    else if (index > 0 && (positions[index] as number) < (positions[index - 1] as number)) problems.push(`${step.id}: registered out of the milestone-1 order`);
    for (const link of step.links) {
      if (!("step" in link)) continue;
      if (!order.includes(link.step)) problems.push(`${step.id}: links to ${link.step}, which is not a step`);
      else if (link.step === step.id) problems.push(`${step.id}: links to itself`);
    }
    for (const write of step.writesState ?? []) {
      if (!isMethodName(write.method)) problems.push(`${step.id}: writes state through ${write.method}, which is not a method`);
    }
    for (const confirmation of step.confirms ?? []) {
      for (const key of [confirmation.key, confirmation.records]) {
        if (!step.writes.includes(key)) problems.push(`${step.id}: confirms through ${key}, which it does not write`);
      }
    }
    for (const check of step.stateChecks) {
      if (!check.id.startsWith(`${step.id}.`)) problems.push(`${step.id}: state check ${check.id} is not named for it`);
      for (const action of check.actions) {
        if (!(SETUP_ACTIONS as readonly string[]).includes(action)) problems.push(`${step.id}: ${check.id} offers ${action}, which is no named action`);
      }
    }
  });
  const checkIds = steps.flatMap((step) => step.stateChecks.map((check) => check.id));
  for (const id of new Set(checkIds)) if (checkIds.filter((other) => other === id).length > 1) problems.push(`${id}: a state check named twice`);
  return problems;
};

/**
 * What the Permissions entry misses of what the permissions spec says the
 * step writes ("The Permissions step"): every permission settings key, the
 * denylist's four sections through `permissions.denylist.set`, and the bypass
 * sentence with its acknowledgement on the unattended mode.
 */
const permissionsEntryProblems = (step: LooseStep): string[] => [
  ...PERMISSION_SETTINGS_KEYS.filter((key) => !step.writes.includes(key)).map((key) => `permissions: does not write ${key}`),
  ...DENYLIST_SECTIONS.filter(
    (section) => !(step.writesState ?? []).some((write) => write.method === "permissions.denylist.set" && write.parts.includes(section)),
  ).map((section) => `permissions: does not write the denylist's ${section}`),
  ...((step.confirms ?? []).some(
    (confirmation) =>
      confirmation.key === "permissions.unattended.mode" &&
      confirmation.value === "bypassPermissions" &&
      confirmation.sentence === BYPASS_SENTENCE &&
      confirmation.acknowledgement === "acknowledgeBypass" &&
      confirmation.records === "permissions.unattended.bypassAcknowledgedAt",
  )
    ? []
    : ["permissions: does not confirm an unattended bypassPermissions with the bypass sentence and its acknowledgement"]),
];

const settings = SETTINGS as LooseSettings;
const steps = STEP_REGISTRY as readonly LooseStep[];
const stepOf = (id: string): LooseStep => {
  const found = steps.find((step) => step.id === id);
  if (found === undefined) throw new Error(`no step ${id} is registered`);
  return found;
};
const appearance = stepOf("appearance");
const account = stepOf("account");
const permissions = stepOf("permissions");
/** The Appearance step's keys alone (the auto-settle keys and the transcript compaction window): the table its broken-on-purpose registries are checked against. */
const sessionSettings = Object.fromEntries(
  [...AUTO_SETTLE_KEYS, "sessions.transcriptCompactAfterDays" as const].map((key) => [key, SETTINGS[key]]),
) as LooseSettings;

describe("the step registry", () => {
  it("has every settings key named by, written by and linked from one registered step, each written key checked", () => {
    expect(stepRegistryProblems(settings, steps)).toEqual([]);
    expect(stepShapeProblems(steps)).toEqual([]);
  });

  it("registers its steps in the milestone-1 order of ADR 0016 as ADR 0020 and ADR 0034 amend it", () => {
    expect(STEP_ORDER).toEqual([
      "account",
      "carry-over",
      "your-machines",
      "forges",
      "key-manager",
      "memory-bank",
      "skills",
      "instructions",
      "browser",
      "permissions",
      "appearance",
    ]);
    expect(STEP_REGISTRY.map((step) => step.id)).toEqual(["account", "your-machines", "permissions", "appearance"]);
  });

  it("puts both auto-settle keys and the transcript compaction window under the Appearance entry's Sessions band", () => {
    expect(appearance.writes).toEqual(["sessions.autoSettleAfterIdle", "sessions.autoSettleOnMerge", "sessions.transcriptCompactAfterDays"]);
    expect(appearance.links).toEqual([{ pane: "appearance", band: "sessions" }]);
    for (const key of AUTO_SETTLE_KEYS) expect(SETTINGS[key].step, key).toEqual({ id: "appearance", band: "sessions" });
  });

  it("puts the five permission keys under the Permissions entry, in the Access band (ADR 0027: access.permissions)", () => {
    expect(permissions.writes).toEqual([...PERMISSION_SETTINGS_KEYS]);
    expect(paneLinks(permissions)).toEqual([{ pane: "permissions", band: "access" }]);
    for (const key of PERMISSION_SETTINGS_KEYS) expect(SETTINGS[key].step, key).toEqual({ id: "permissions", band: "access" });
  });

  it("stands the Permissions entry directly after Browser and before Appearance: ninth of ADR 0016's ten, tenth of the eleven since ADR 0020's Forges", () => {
    const order = STEP_ORDER as readonly string[];
    expect(order.indexOf("permissions")).toBe(9);
    expect(order[order.indexOf("permissions") - 1]).toBe("browser");
    expect(order[order.indexOf("permissions") + 1]).toBe("appearance");
  });

  it("names every settings key the permissions spec writes, the denylist's four sections and the bypass sentence with its acknowledgement (#141)", () => {
    expect(permissionsEntryProblems(permissions)).toEqual([]);
    expect(permissions.writesState).toEqual([{ method: "permissions.denylist.set", parts: ["browserDomains", "paths", "commandPatterns", "hosts"] }]);
    expect(permissions.confirms).toEqual([
      {
        key: "permissions.unattended.mode",
        value: "bypassPermissions",
        sentence: BYPASS_SENTENCE,
        acknowledgement: "acknowledgeBypass",
        records: "permissions.unattended.bypassAcknowledgedAt",
      },
    ]);
  });

  it("fails when the Permissions entry misses a key the permissions spec writes, a denylist section, or the bypass confirmation", () => {
    const without = (key: string): LooseStep => ({ ...permissions, writes: permissions.writes.filter((written) => written !== key) });
    expect(permissionsEntryProblems(without("permissions.parkedPrompt.ttl"))).toEqual(["permissions: does not write permissions.parkedPrompt.ttl"]);
    expect(permissionsEntryProblems(without("permissions.unattended.bypassAcknowledgedAt"))).toEqual([
      "permissions: does not write permissions.unattended.bypassAcknowledgedAt",
    ]);
    expect(permissionsEntryProblems({ ...permissions, writesState: [{ method: "permissions.denylist.set", parts: ["browserDomains", "paths", "hosts"] }] })).toEqual([
      "permissions: does not write the denylist's commandPatterns",
    ]);
    expect(permissionsEntryProblems({ ...permissions, writesState: [{ method: "permissions.denylist.get", parts: [...DENYLIST_SECTIONS] }] })).toHaveLength(4);
    expect(permissionsEntryProblems({ ...permissions, confirms: [] })).toEqual([
      "permissions: does not confirm an unattended bypassPermissions with the bypass sentence and its acknowledgement",
    ]);
  });

  it("links the Permissions entry to the Your machines step, checks containment, the denylist's presets and not-root, and is never skipped", () => {
    expect(permissions.links).toEqual([{ pane: "permissions", band: "access" }, { step: "your-machines" }]);
    expect(permissions.stateChecks.map((check) => [check.id, check.actions])).toEqual([
      ["permissions.containment", []],
      ["permissions.denylist", ["restore"]],
      ["permissions.not-root", []],
    ]);
    expect(permissions.skippable).toBe(false);
  });

  it("gives the Your machines entry its not-root line and no setting yet (ADR 0027: environments.machines)", () => {
    const machines = stepOf("your-machines");
    expect(machines).toMatchObject({ writes: [], checks: [], links: [{ pane: "machines", band: "environments" }], skippable: false });
    expect(machines.stateChecks).toEqual([{ id: "your-machines.not-root", holds: "The environment runs as a non-root user.", actions: [] }]);
  });

  it("fails a step out of the order or outside it, a link to no step or to itself, state through no method, a confirmation of an unwritten key, and a misnamed, doubled or unknown state check", () => {
    expect(stepShapeProblems([appearance, account])).toEqual(["account: registered out of the milestone-1 order"]);
    expect(stepShapeProblems([{ ...account, id: "housekeeping" }])).toEqual(["housekeeping: not a step of the milestone-1 order"]);
    expect(stepShapeProblems([{ ...permissions, links: [{ step: "settings" }, { step: "permissions" }] }])).toEqual([
      "permissions: links to settings, which is not a step",
      "permissions: links to itself",
    ]);
    expect(stepShapeProblems([{ ...permissions, writesState: [{ method: "permissions.denylist.put", parts: ["paths"] }] }])).toEqual([
      "permissions: writes state through permissions.denylist.put, which is not a method",
    ]);
    const confirms = permissions.confirms?.map((confirmation) => ({ ...confirmation, records: "permissions.unattended.acknowledged" }));
    expect(stepShapeProblems([{ ...permissions, ...(confirms !== undefined && { confirms }) }])).toEqual([
      "permissions: confirms through permissions.unattended.acknowledged, which it does not write",
    ]);
    expect(
      stepShapeProblems([
        { ...account, stateChecks: [{ id: "permissions.not-root", holds: "x", actions: ["reboot"] }] },
        permissions,
      ]),
    ).toEqual([
      "account: state check permissions.not-root is not named for it",
      "account: permissions.not-root offers reboot, which is no named action",
      "permissions.not-root: a state check named twice",
    ]);
  });

  it("puts the default account, model family and effort and providers.processIdleMinutes under the Account entry's Default account and model band, each checked done on any valid value", () => {
    const keys = ["accounts.defaultAccount", "accounts.defaultModelFamily", "accounts.defaultEffort", "providers.processIdleMinutes"] as const;
    expect(account.writes).toEqual(keys);
    expect(account.links).toEqual([{ pane: "accounts", band: "default-model" }]);
    for (const key of keys) expect(SETTINGS[key].step, key).toEqual({ id: "account", band: "default-model" });
    const checkOf = (key: string) => (account.checks.find((entry) => entry.key === key) as LooseStep["checks"][number]).check;
    for (const key of keys.slice(0, 3)) {
      expect(checkOf(key)(null), key).toBe(true);
      expect(checkOf(key)("opus"), key).toBe(true);
      expect(checkOf(key)(""), key).toMatch(key);
    }
    const check = checkOf("providers.processIdleMinutes");
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
    const other: LooseStep = { id: "permissions", writes: ["sessions.autoSettleOnMerge"], checks: [], stateChecks: [], links: [], skippable: false };
    const withoutMerge = { ...appearance, writes: appearance.writes.filter((key) => key !== "sessions.autoSettleOnMerge"), checks: appearance.checks.filter((check) => check.key !== "sessions.autoSettleOnMerge") };
    expect(stepRegistryProblems(sessionSettings, [withoutMerge, other])).toEqual([
      "sessions.autoSettleOnMerge: names appearance but permissions writes it",
      "permissions: needs one health check of sessions.autoSettleOnMerge",
    ]);
    expect(stepRegistryProblems(sessionSettings, [appearance, { ...other, checks: [appearance.checks[1] as LooseStep["checks"][number]] }])).toEqual([
      "sessions.autoSettleOnMerge: written by appearance, permissions",
    ]);
  });

  it("fails when a step writes a key that is not a setting, writes a key it does not check, or links to no band a key sits in", () => {
    expect(stepRegistryProblems(sessionSettings, [{ ...appearance, writes: [...appearance.writes, "appearance.theme"] }])).toEqual([
      "appearance: writes appearance.theme, which is not a setting",
      "appearance: needs one health check of appearance.theme",
    ]);
    expect(stepRegistryProblems(sessionSettings, [{ ...appearance, checks: [] }])).toEqual([
      "appearance: needs one health check of sessions.autoSettleAfterIdle",
      "appearance: needs one health check of sessions.autoSettleOnMerge",
      "appearance: needs one health check of sessions.transcriptCompactAfterDays",
    ]);
    expect(stepRegistryProblems(sessionSettings, [{ ...appearance, links: [{ pane: "appearance", band: "theme" }] }])).toEqual([
      "sessions.autoSettleAfterIdle: appearance links to no sessions band",
      "sessions.autoSettleOnMerge: appearance links to no sessions band",
      "sessions.transcriptCompactAfterDays: appearance links to no sessions band",
    ]);
    expect(stepRegistryProblems(sessionSettings, [appearance, appearance])).toEqual([
      "appearance: registered twice",
      "sessions.autoSettleAfterIdle: written by appearance, appearance",
      "sessions.autoSettleOnMerge: written by appearance, appearance",
      "sessions.transcriptCompactAfterDays: written by appearance, appearance",
    ]);
  });

  it("checks each key done on any valid value, the preset included, and names the key when it is not", () => {
    const check = (key: SettingsKey) => (appearance.checks.find((entry) => entry.key === key) as LooseStep["checks"][number]).check;
    const presets = presetSettings();
    for (const key of AUTO_SETTLE_KEYS) expect(check(key)(presets[key]), key).toBe(true);
    for (const value of [null, { amount: 1, unit: "days" }, { amount: 3, unit: "weeks" }, { amount: 1000, unit: "months" }]) {
      expect(check("sessions.autoSettleAfterIdle")(value), JSON.stringify(value)).toBe(true);
    }
    expect(check("sessions.autoSettleOnMerge")(true)).toBe(true);
    expect(check("sessions.transcriptCompactAfterDays")(1)).toBe(true);
    expect(check("sessions.transcriptCompactAfterDays")(0)).toMatch(/sessions\.transcriptCompactAfterDays/);
    expect(check("sessions.autoSettleAfterIdle")({ amount: 0, unit: "days" })).toMatch(/sessions\.autoSettleAfterIdle/);
    expect(check("sessions.autoSettleOnMerge")("yes")).toMatch(/sessions\.autoSettleOnMerge/);
  });
});
