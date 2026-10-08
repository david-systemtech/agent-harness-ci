import { describe, expect, it } from "vitest";
import {
  AUTO_SETTLE_KEYS,
  BROWSER_SETTINGS_KEYS,
  BYPASS_SENTENCE,
  CHECK_BUDGET_SECONDS,
  CREDENTIAL_SETTINGS_KEYS,
  DEFAULT_CADENCE_MINUTES,
  DENYLIST_SECTIONS,
  EVENT_TYPES,
  NETWORK_SETTINGS_KEYS,
  OWED_HANDLERS,
  PERMISSION_SETTINGS_KEYS,
  REGISTERED_STEP_IDS,
  SETTINGS,
  SETUP_ACTIONS,
  STEP_LABELS,
  STEP_HINTS,
  STEP_PROMPTS,
  STEP_ORDER,
  STEP_REGISTRY,
  anyValidValue,
  UPDATE_SETTINGS_KEYS,
  isMethodName,
  presetSettings,
  registry,
  settingsRow,
  triggerMatches,
  unregisteredSteps,
  type SettingsKey,
} from "./index.js";

it("explains the outcome of every checklist step, including optional steps, in setup-copy.md §4.4's words", () => {
  expect(STEP_ORDER.map((id) => STEP_HINTS[id])).toEqual([
    "Sign in to Claude", "Bring your past chats", "Use it from other devices", "Connect GitHub and others",
    "Use your key manager", "A notebook agents keep", "Ready-made agent skills", "Notes every agent reads",
    "Let agents use Chrome", "When agents must ask", "Light, dark and colours",
  ]);
});

/** What a value check says of a key whose value it cannot use (setup-copy.md §3): the setting's label in the line, the key in details. */
const refused = (key: SettingsKey) => ({ reason: `A saved setting for this step cannot be used: ${SETTINGS[key].label}. Set it again in Settings.`, details: [key] });

it("names a setting it cannot use by its label, the key only in details (setup-copy.md §3)", () => {
  const check = anyValidValue("updates.idleWindowMinutes");
  expect(check(0)).toEqual({ reason: "A saved setting for this step cannot be used: Quiet time before updates in minutes. Set it again in Settings.", details: ["updates.idleWindowMinutes"] });
  expect(check(30)).toBe(true);
});

/**
 * The step registry's contract test (ADR 0016; session-state spec,
 * "Auto-settle: rules and settings"): every settings key names a
 * registered step that writes it, and every step writes only settings keys,
 * each with a health check (the row each key sits on and each step's home
 * row are the row registry's test, `settings-rows.test.ts`); the steps stand in
 * the milestone-1 order, link only to steps of it, write state only through
 * registered methods, confirm only keys they write, and name their state
 * checks for themselves (#141); each declares its check's budget class, its
 * cadence, one other than the hour with its reason, and the event and notice
 * types that re-run it, and every skippable step and no other a skip check,
 * one of its own (ADR 0031; #308, #568); an LLM step names a prompt
 * `STEP_PROMPTS` has (ADR 0019; #584); no part of the state steps write
 * through their own methods is named by two. The Permissions entry names
 * every settings key the permissions spec writes and the denylist's four
 * sections. Each
 * check is a plain function over the tables, so each failure it exists to
 * catch is shown failing on a table broken on purpose.
 */

/** A settings table as the check reads it, typed loosely so a broken one can be written. */
type LooseSettings = Readonly<Record<string, { readonly step: { readonly id: string; readonly row: string } }>>;

/** A step as the check reads it, typed loosely so a broken one can be written. */
interface LooseStep {
  readonly id: string;
  readonly writes: readonly string[];
  readonly writesState?: readonly { readonly method: string; readonly parts: readonly string[] }[];
  readonly confirms?: readonly { readonly key: string; readonly value: unknown; readonly sentence: string; readonly acknowledgement: string; readonly records: string }[];
  readonly checks: readonly { readonly key: string; readonly check: (value: unknown) => true | { readonly reason: string; readonly details: readonly string[] } }[];
  readonly stateChecks: readonly { readonly id: string; readonly holds: string; readonly actions: readonly string[] }[];
  readonly links: readonly ({ readonly row: string } | { readonly step: string })[];
  readonly skippable: boolean;
  /** Optional here, so a table missing one can be written. */
  readonly budget?: string;
  readonly cadence?: { readonly minutes: number; readonly reason?: string };
  readonly triggers?: readonly string[];
  readonly skip?: string;
  readonly llm?: string;
}

/** Every event and notice type the log carries, on any stream: what a trigger may name. */
const KNOWN_TYPES = Object.values(EVENT_TYPES).flatMap((table) => Object.keys(table));

/**
 * Methods a registered step writes state through that a later ticket
 * registers, each with that ticket: the Memory bank step's four (#586),
 * which the banks build registers (#937). A method leaves this list in the
 * change that registers it, which the test below holds it to.
 */
const STATE_WRITERS_OWED: Readonly<Record<string, `#${number}`>> = {
};

/**
 * Triggers a registered step names before any event or notice type they
 * name is registered, each with the ticket that registers the types. None
 * is owed since the banks build registered its `bank.*` notices (#1025). A
 * trigger leaves this list in the change that registers a type it names,
 * which the test below holds it to.
 */
const TRIGGERS_OWED: Readonly<Record<string, `#${number}`>> = {};

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
 * `<step>.<what>` or named twice, an action outside ADR 0031's vocabulary,
 * a budget that is none of ADR 0031's three, a cadence that is no whole
 * number of minutes or leaves the hour without a reason, no triggers or a
 * trigger that names, or as a family prefixes, no event or notice type and
 * is not owed to the ticket that registers its types (#586), a skippable
 * step with no skip check, a skip check on a step that may not be skipped
 * or that names none of its own state checks, a prompt in `llm`
 * that none of `prompts` has (ADR 0019; #584), or a part of the state
 * steps write through their own methods that two steps name.
 */
const stepShapeProblems = (steps: readonly LooseStep[], prompts: readonly { readonly id: string }[] = STEP_PROMPTS): string[] => {
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
      if (!isMethodName(write.method) && !Object.hasOwn(STATE_WRITERS_OWED, write.method)) problems.push(`${step.id}: writes state through ${write.method}, which is not a method`);
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
    if (step.budget === undefined) problems.push(`${step.id}: declares no budget`);
    else if (!Object.hasOwn(CHECK_BUDGET_SECONDS, step.budget)) problems.push(`${step.id}: a budget of ${step.budget} is not local, network or git`);
    if (step.cadence === undefined) problems.push(`${step.id}: declares no cadence`);
    else if (!Number.isInteger(step.cadence.minutes) || step.cadence.minutes < 1) problems.push(`${step.id}: a cadence of ${step.cadence.minutes} minutes is no whole number of minutes`);
    else if (step.cadence.minutes !== DEFAULT_CADENCE_MINUTES && !step.cadence.reason?.trim()) {
      problems.push(`${step.id}: a cadence of ${step.cadence.minutes} minutes states no reason for leaving the hour`);
    }
    if (step.triggers === undefined) problems.push(`${step.id}: declares no triggers`);
    for (const trigger of step.triggers ?? []) {
      if (!KNOWN_TYPES.some((type) => triggerMatches(trigger, type)) && !Object.hasOwn(TRIGGERS_OWED, trigger)) {
        problems.push(`${step.id}: triggers on ${trigger}, which ${trigger.endsWith("*") ? "prefixes" : "names"} no event or notice type`);
      }
    }
    if (step.skippable && step.skip === undefined) problems.push(`${step.id}: may be skipped but names no skip check`);
    if (step.skip !== undefined) {
      if (!step.skippable) problems.push(`${step.id}: names the skip check ${step.skip} but may not be skipped`);
      if (!step.stateChecks.some((check) => check.id === step.skip)) problems.push(`${step.id}: its skip check ${step.skip} is none of its state checks`);
    }
    if (step.llm !== undefined && !prompts.some((prompt) => prompt.id === step.llm)) problems.push(`${step.id}: names the prompt ${step.llm} in llm, which is none of STEP_PROMPTS`);
  });
  const checkIds = steps.flatMap((step) => step.stateChecks.map((check) => check.id));
  for (const id of new Set(checkIds)) if (checkIds.filter((other) => other === id).length > 1) problems.push(`${id}: a state check named twice`);
  for (const part of new Set(steps.flatMap((step) => (step.writesState ?? []).flatMap((write) => write.parts)))) {
    const writers = steps.filter((step) => (step.writesState ?? []).some((write) => write.parts.includes(part))).map((step) => step.id);
    if (writers.length > 1) problems.push(`${part}: state written by ${writers.join(", ")}`);
  }
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
const machines = stepOf("your-machines");
const carryOver = stepOf("carry-over");
const forges = stepOf("forges");
const keyManager = stepOf("key-manager");
const memoryBank = stepOf("memory-bank");
const permissions = stepOf("permissions");
/** The session keys: the auto-settle keys and the transcript compaction window. */
const SESSION_KEYS: readonly string[] = [...AUTO_SETTLE_KEYS, "sessions.transcriptCompactAfterDays"];
/** The session keys' settings alone: the table the broken-on-purpose registries below are checked against. */
const sessionSettings = Object.fromEntries(SESSION_KEYS.map((key) => [key, SETTINGS[key as SettingsKey]])) as LooseSettings;
/** The Your machines entry cut down to the session keys it writes, which `sessionSettings` holds. */
const sessionsStep: LooseStep = {
  ...machines,
  writes: machines.writes.filter((key) => SESSION_KEYS.includes(key)),
  checks: machines.checks.filter((check) => SESSION_KEYS.includes(check.key)),
};

describe("the step registry", () => {
  it("has every settings key named by and written by one registered step, each written key checked", () => {
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
    expect(STEP_REGISTRY.map((step) => step.id)).toEqual(["account", "carry-over", "your-machines", "forges", "key-manager", "memory-bank", "skills", "instructions", "browser", "permissions", "appearance"]);
  });

  it("registers the Carry over entry second, after Account, at home on accounts.accounts beside it, writing no settings key and its state through carryOver.run, skills.carryOver and stateImport.run (ADR 0021, ADR 0036; #581)", () => {
    const order = STEP_ORDER as readonly string[];
    expect(order.indexOf("carry-over")).toBe(1);
    expect(STEP_REGISTRY.find((step) => step.id === "carry-over")?.home).toBe("accounts.accounts");
    expect(STEP_REGISTRY.find((step) => step.id === "account")?.home).toBe("accounts.accounts");
    expect(carryOver).toMatchObject({ writes: [], checks: [] });
    expect(Object.values(SETTINGS).filter((setting) => setting.step.id === "carry-over")).toEqual([]);
    expect(carryOver.writesState?.map((write) => write.method)).toEqual(["carryOver.run", "skills.carryOver", "stateImport.run"]);
  });

  it("links the Carry over entry to the Skills and Memory banks rows, with the local budget and the hour, re-run on account.updated, carry-over.imported and state-import.finished", () => {
    expect(carryOver.links).toEqual([{ row: "knowledge.skills" }, { row: "knowledge.banks" }]);
    expect(carryOver).toMatchObject({ budget: "local", cadence: { minutes: 60 }, triggers: ["account.updated", "carry-over.imported", "state-import.finished", "settings.changed"] });
  });

  it("may skip Carry over, skipped when carry-over.present finds nothing to carry and no source folder, then checks every adopted directory readable and the last import finished", () => {
    expect(carryOver).toMatchObject({ skippable: true, skip: "carry-over.present" });
    expect(carryOver.stateChecks).toEqual([
      {
        id: "carry-over.present",
        holds: "An adopted account's directory holds something to carry, or a source data folder or terminal-client state folder is on this machine.",
        actions: [],
      },
      { id: "carry-over.readable", holds: "Every adopted account's directory can be read.", actions: ["check-again"] },
      { id: "carry-over.last-import", holds: "Every adopted account with something to carry has been imported, and its last import finished.", actions: ["import-again"] },
      { id: "carry-over.default-account", holds: "No imported default Account is waiting for sign-in.", actions: ["sign-in-again"] },
    ]);
  });

  it("owes a state writer only while it is not a method, each to a named ticket", () => {
    for (const [method, ticket] of Object.entries(STATE_WRITERS_OWED)) {
      expect(isMethodName(method), `${method} is registered now: take it off STATE_WRITERS_OWED`).toBe(false);
      expect(ticket, method).toMatch(/^#\d+$/);
      expect(steps.some((step) => step.writesState?.some((write) => write.method === method)), method).toBe(true);
    }
  });

  it("registers Skills in milestone-1 order with local state checks, its pane and state-derived skip", () => {
    const skills = stepOf("skills");
    expect(skills).toMatchObject({ home: "knowledge.skills", writes: [], skippable: true, skip: "skills.present", budget: "local", links: [] });
    expect(skills.stateChecks.map((check) => [check.id, check.actions])).toEqual([
      ["skills.present", []],
      ["skills.sources-synced", ["pull-now"]],
      ["skills.sources-yield", ["pull-now"]],
      ["skills.source-limit", []],
      ["skills.own-directory", []],
    ]);
    expect(skills.writesState?.map((write) => write.method)).toEqual([
      "skills.sources.add", "skills.sources.remove", "skills.sources.setFollow", "skills.sources.pull", "skills.setAlwaysOn", "trust.decide", "trust.revoke",
    ]);
  });

  it("owes a trigger only while it names no event or notice type, each to a named ticket", () => {
    for (const [trigger, ticket] of Object.entries(TRIGGERS_OWED)) {
      expect(
        KNOWN_TYPES.filter((type) => triggerMatches(trigger, type)),
        `${trigger} names a registered type now: take it off TRIGGERS_OWED`,
      ).toEqual([]);
      expect(ticket, trigger).toMatch(/^#\d+$/);
      expect(steps.some((step) => step.triggers?.includes(trigger)), trigger).toBe(true);
    }
    expect(stepShapeProblems([{ ...appearance, triggers: ["bank.*", "bank.archived"] }])).toEqual(["appearance: triggers on bank.archived, which names no event or notice type"]);
  });

  it("registers the Instructions entry eighth in the order, at home on knowledge.instructions, writing the orientation switch, done on any valid value, and the owned instructions and dismissed suggestions through their ten commands, never skipped, with its orientation state check and the instruction and orientation registry triggers (#588)", () => {
    const instructions = stepOf("instructions");
    expect((STEP_ORDER as readonly string[]).indexOf("instructions")).toBe(7);
    expect(instructions).toMatchObject({ home: "knowledge.instructions", writes: ["instructions.orientation"], stateChecks: [{ id: "instructions.orientation-renders", actions: [] }], links: [], skippable: false, budget: "local", triggers: ["bank.*", "instructions.*", "account.updated", "key-manager.*", "forge.account.*", "environment.renamed"] });
    expect(instructions).not.toHaveProperty("skip");
    expect(instructions.writesState?.map((write) => write.method)).toEqual([
      "instructions.create",
      "instructions.edit",
      "instructions.setScope",
      "instructions.setEnabled",
      "instructions.move",
      "instructions.resolveVersion",
      "instructions.remove",
      "instructions.dismissSuggestion",
      "instructions.restoreSuggestion",
      "instructions.import",
    ]);
    const [check] = instructions.checks;
    expect(check?.key).toBe("instructions.orientation");
    expect([check?.check(true), check?.check(false), check?.check("on")]).toEqual([true, true, refused("instructions.orientation")]);
  });

  it("registers the Browser entry ninth in the order, at home on access.browser, writing the nine browser keys each done on any valid value, with pairing state writes, three state checks, the local budget and the hour, and the browser triggers", () => {
    const browser = stepOf("browser");
    expect((STEP_ORDER as readonly string[]).indexOf("browser")).toBe(8);
    expect(STEP_REGISTRY.find((step) => step.id === "browser")?.home).toBe("access.browser");
    expect(browser.writes).toEqual([...BROWSER_SETTINGS_KEYS]);
    expect(browser.checks.map((check) => check.key)).toEqual([...BROWSER_SETTINGS_KEYS]);
    expect(browser).toMatchObject({ links: [], skippable: true, skip: "browser.present", budget: "local", cadence: { minutes: 60 }, triggers: ["chrome.updated", "extension.seen"] });
    expect(browser.writesState).toEqual([
      { method: "browser.pairing.code", parts: ["pairedChromes"] },
      { method: "browser.chromes.unpair", parts: ["pairedChromes"] },
    ]);
    expect(browser.stateChecks).toEqual([
      { id: "browser.present", holds: "A Chrome is paired with this environment.", actions: [] },
      { id: "browser.chrome-connected", holds: "A paired Chrome is connected.", actions: ["check-again", "unpair", "pair-another"] },
      { id: "browser.extension-current", holds: "Every paired Chrome last reported the shipped extension version.", actions: ["reload", "check-again"] },
    ]);
    const presets = presetSettings();
    for (const check of browser.checks) expect(check.check(presets[check.key as SettingsKey]), check.key).toBe(true);
    expect(browser.checks.find((check) => check.key === "browser.devSites")?.check(["https://myapp.test"])).toEqual(refused("browser.devSites"));
  });

  it("exports the check the switch-over's done checklist runs: the steps of the milestone-1 order no entry registers, in that order (#94)", () => {
    expect(unregisteredSteps(STEP_ORDER.map((id) => ({ id })))).toEqual([]);
    expect(unregisteredSteps([{ id: "account" }, { id: "your-machines" }, { id: "forges" }, { id: "permissions" }, { id: "appearance" }])).toEqual([
      "carry-over",
      "key-manager",
      "memory-bank",
      "skills",
      "instructions",
      "browser",
    ]);
    // Until #94 the package checks only the registered ids: by default the check reads the registry, which names none of them.
    for (const id of STEP_REGISTRY.map((step) => step.id)) expect(unregisteredSteps(), id).not.toContain(id);
  });

  it("names each of the eleven steps alike for every client, registered or not", () => {
    expect(STEP_ORDER.map((id) => STEP_LABELS[id])).toEqual([
      "Account",
      "Carry over",
      "Your machines",
      "Forges",
      "Key manager",
      "Memory bank",
      "Skills",
      "Instructions",
      "Browser",
      "Permissions",
      "Appearance",
    ]);
    expect(Object.keys(STEP_LABELS)).toEqual([...STEP_ORDER]);
  });

  it("gives every step one short sentence for its line when done, saying what was found rather than joining its checks' conditions, in its setup-copy.md §5 words (#1698, #1836)", () => {
    expect(Object.fromEntries(STEP_REGISTRY.map((step) => [step.id, step.done]))).toEqual({
      account: "All your accounts are signed in.",
      "carry-over": "Everything is already here.",
      "your-machines": "This computer is ready.",
      forges: "Your forges are connected.",
      "key-manager": "Your key managers are connected.",
      "memory-bank": "Your notebook is ready.",
      skills: "Your skills are up to date.",
      instructions: "Agents get your notes and a summary of this computer.",
      browser: "Chrome is connected.",
      permissions: "Set.",
      appearance: "Your theme is easy to read.",
    });
    for (const step of STEP_REGISTRY) {
      expect(step.done, step.id).toMatch(/^[A-Z][^.]*\.$/);
      expect(step.done.length, step.id).toBeLessThanOrEqual(80);
      expect(step.done, step.id).not.toMatch(/\bor\b/);
    }
  });

  it("puts both auto-settle keys and the transcript compaction window under the Your machines entry, still on environments.service, which it links", () => {
    expect(machines.writes.filter((key) => key.startsWith("sessions."))).toEqual(["sessions.autoSettleAfterIdle", "sessions.autoSettleOnMerge", "sessions.transcriptCompactAfterDays"]);
    expect(machines.links).toEqual([{ row: "environments.service" }]);
    for (const key of SESSION_KEYS) expect(SETTINGS[key as SettingsKey].step, key).toEqual({ id: "your-machines", row: "environments.service" });
  });

  it("gives the Appearance entry the theme on its home row appearance.theme, the state check appearance.contrast with Restore, and never skips it (ADR 0023, ADR 0031; #391)", () => {
    expect(appearance).toMatchObject({ home: "appearance.theme", writes: ["appearance.theme"], links: [], budget: "local", triggers: ["settings.updated"] });
    expect(appearance.checks.map((check) => check.key)).toEqual(["appearance.theme"]);
    expect(SETTINGS["appearance.theme"].step).toEqual({ id: "appearance", row: "appearance.theme" });
    expect(appearance.stateChecks).toEqual([
      { id: "appearance.contrast", holds: "Both ladders of the theme meet the contrast, gamut and hue-separation rules with no seed clamped.", actions: ["restore"] },
    ]);
    expect(appearance.skippable).toBe(false);
    expect(appearance.skip).toBeUndefined();
  });

  it("puts the five permission keys under the Permissions entry, on its home row access.permissions (ADR 0027)", () => {
    expect(permissions.writes).toEqual([...PERMISSION_SETTINGS_KEYS]);
    expect(STEP_REGISTRY.find((step) => step.id === "permissions")?.home).toBe("access.permissions");
    for (const key of PERMISSION_SETTINGS_KEYS) expect(SETTINGS[key].step, key).toEqual({ id: "permissions", row: "access.permissions" });
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
    expect(permissions.links).toEqual([{ step: "your-machines" }]);
    expect(permissions.stateChecks.map((check) => [check.id, check.actions])).toEqual([
      ["permissions.containment", []],
      ["permissions.denylist", ["restore"]],
      ["permissions.not-root", []],
    ]);
    expect(permissions.skippable).toBe(false);
  });

  it("gives the Your machines entry the five update keys, the three session keys and the two binding keys as its writes, on its home row environments.machines (ADR 0027), its not-root line, the release channel's check (#346), whether the machine is behind (#347) and, managed outside, the host-side updater's poll (#348), that it is named (#323), and that it is ready, not draining past its cap (#574)", () => {
    expect(machines.writes).toEqual([
      "updates.autoUpdate",
      "updates.channel",
      "updates.pinnedVersion",
      "updates.idleWindowMinutes",
      "updates.deferralCapHours",
      "sessions.autoSettleAfterIdle",
      "sessions.autoSettleOnMerge",
      "sessions.transcriptCompactAfterDays",
      "network.bindTailnet",
      "network.bindLan",
    ]);
    expect(machines.writes).toEqual([...UPDATE_SETTINGS_KEYS, ...SESSION_KEYS, ...NETWORK_SETTINGS_KEYS]);
    expect(machines.checks.map((check) => check.key)).toEqual(machines.writes);
    expect(machines).toMatchObject({ home: "environments.machines", links: [{ row: "environments.service" }], skippable: false });
    for (const key of UPDATE_SETTINGS_KEYS) expect(SETTINGS[key].step, key).toEqual({ id: "your-machines", row: "environments.machines" });
    expect(machines.stateChecks).toEqual([
      { id: "your-machines.not-root", holds: "The environment runs as a non-root user.", actions: [] },
      { id: "your-machines.release-channel", holds: "Auto-update is off, or the release channel was read in the last 24 hours.", actions: ["check-again"] },
      {
        id: "your-machines.updates",
        holds: "Auto-update is on or the channel's newest runs, no update is past its cap or blocked, and no failed update left this machine behind.",
        actions: ["update"],
      },
      { id: "your-machines.host-updater", holds: "No host-side updater manages this environment's updates, or it polled in the last hour.", actions: ["how-to-set-up", "check-again"] },
      { id: "your-machines.named", holds: "The environment has a name, an icon and a colour.", actions: [] },
      { id: "your-machines.ready", holds: "The environment is ready, and not draining past its cap.", actions: ["check-again"] },
      { id: "your-machines.lan", holds: "LAN binding is off, or the LAN address it names is one this machine holds.", actions: ["check-again"] },
    ]);
  });

  it("puts the two binding keys under the Your machines entry, on its home row environments.machines, each written by settings.update and done on any valid value: the tailnet on or off, preset on, and the LAN off or an address that is not the wildcard, preset off (#574)", () => {
    expect(NETWORK_SETTINGS_KEYS).toEqual(["network.bindTailnet", "network.bindLan"]);
    for (const key of NETWORK_SETTINGS_KEYS) {
      expect(SETTINGS[key].step, key).toEqual({ id: "your-machines", row: "environments.machines" });
      expect(SETTINGS[key], key).not.toHaveProperty("writtenBy");
      expect(stepRegistryProblems(settings, steps).filter((problem) => problem.startsWith(key)), key).toEqual([]);
    }
    const checkOf = (key: string) => (machines.checks.find((check) => check.key === key) as LooseStep["checks"][number]).check;
    const presets = presetSettings();
    expect([presets["network.bindTailnet"], presets["network.bindLan"]]).toEqual([true, null]);
    for (const value of [true, false]) expect(checkOf("network.bindTailnet")(value)).toBe(true);
    for (const value of [null, "192.168.1.20", "10.0.0.7", "fd00::20"]) expect(checkOf("network.bindLan")(value), String(value)).toBe(true);
    expect(checkOf("network.bindTailnet")(null)).toEqual(refused("network.bindTailnet"));
    for (const value of ["0.0.0.0", "::", "0:0:0:0:0:0:0:0", "::ffff:0.0.0.0", "desk.local", "", false, true]) {
      expect(checkOf("network.bindLan")(value), String(value)).toEqual(refused("network.bindLan"));
    }
  });

  it("gives the Your machines entry the environment's name, icon and colour as state it writes, each through its own command (#323)", () => {
    expect(machines.writesState).toEqual([
      { method: "environment.rename", parts: ["name"] },
      { method: "environment.setIcon", parts: ["icon"] },
      { method: "environment.setColour", parts: ["colour"] },
    ]);
    expect(stepShapeProblems([{ ...machines, writesState: [{ method: "environment.setName", parts: ["name"] }] }])).toEqual([
      "your-machines: writes state through environment.setName, which is not a method",
    ]);
  });

  it("registers Forges fourth, after Your machines (ADR 0020, ADR 0034), writing no settings key and its forge accounts through the four forge account commands (#319)", () => {
    const order = STEP_ORDER as readonly string[];
    expect(order.indexOf("forges")).toBe(3);
    expect(order[order.indexOf("forges") - 1]).toBe("your-machines");
    expect(forges).toMatchObject({ writes: [], checks: [] });
    expect(Object.values(SETTINGS).filter((setting) => setting.step.id === "forges")).toEqual([]);
    expect(forges.writesState).toEqual([
      { method: "forge.accounts.add", parts: ["forgeAccounts"] },
      { method: "forge.accounts.update", parts: ["forgeAccounts"] },
      { method: "forge.accounts.remove", parts: ["forgeAccounts"] },
      { method: "forge.accounts.setPrimary", parts: ["forgeAccounts"] },
    ]);
  });

  it("homes Forges on the Access band's Forges row (ADR 0027) and links it to the Key manager step, whose Move card takes stored tokens (ADR 0028)", () => {
    expect(STEP_REGISTRY.find((step) => step.id === "forges")?.home).toBe("access.forges");
    expect(forges.links).toEqual([{ step: "key-manager" }]);
  });

  it("may skip Forges, skipped when forges.present finds no forge account, then checks identity, reads, the primary, gh, expiry and coverage with actions from ADR 0031's vocabulary", () => {
    expect(forges).toMatchObject({ skippable: true, skip: "forges.present" });
    expect(forges.stateChecks.map((check) => [check.id, check.actions])).toEqual([
      ["forges.present", []],
      ["forges.identity", ["sign-in-again", "check-again"]],
      ["forges.reads", ["check-again"]],
      ["forges.primary", []],
      ["forges.gh", ["install", "update", "sign-in-again"]],
      ["forges.expiry", ["sign-in-again"]],
      ["forges.coverage", []],
    ]);
    for (const check of forges.stateChecks) {
      for (const action of check.actions) expect(SETUP_ACTIONS as readonly string[], `${check.id}: ${action}`).toContain(action);
    }
    expect(forges.stateChecks.map((check) => check.holds)).toEqual([
      "At least one forge account is on this environment.",
      "Each forge account answers as the identity it was added with.",
      "Every read of each forge account passes.",
      "Exactly one forge account is primary.",
      "Every forge account whose credential is gh finds gh installed, at 2.40.0 or later, and signed in as its login.",
      "No forge account's token expires within thirty days.",
      "No origin a harness operation was refused on for want of a forge account counts as missing.",
    ]);
  });

  it("registers the Key manager entry fifth in the milestone-1 order, after Forges and before Memory bank (ADR 0034), at home on the Access band's Key managers pane, writing the two injection keys (#367)", () => {
    const order = STEP_ORDER as readonly string[];
    expect(order.indexOf("key-manager")).toBe(4);
    expect(order[order.indexOf("key-manager") - 1]).toBe("forges");
    expect(order[order.indexOf("key-manager") + 1]).toBe("memory-bank");
    expect(STEP_REGISTRY.find((step) => step.id === "key-manager")?.home).toBe("access.key-managers");
    expect(keyManager.writes).toEqual(["credentials.injection", "credentials.injectionByAccount"]);
    expect(keyManager.writes).toEqual([...CREDENTIAL_SETTINGS_KEYS]);
    for (const key of CREDENTIAL_SETTINGS_KEYS) expect(SETTINGS[key].step, key).toEqual({ id: "key-manager", row: "access.key-managers" });
  });

  it("gives the Key manager entry its connections and the Move of stored tokens as the state it writes, through keyManagers.connections.* and keyManagers.move", () => {
    expect(keyManager.writesState).toEqual([
      { method: "keyManagers.connections.add", parts: ["keyManagerConnections"] },
      { method: "keyManagers.connections.signIn", parts: ["keyManagerConnections"] },
      { method: "keyManagers.connections.update", parts: ["keyManagerConnections"] },
      { method: "keyManagers.connections.setPolicies", parts: ["keyManagerConnections"] },
      { method: "keyManagers.connections.setBasePath", parts: ["keyManagerConnections"] },
      { method: "keyManagers.connections.setInjected", parts: ["keyManagerConnections"] },
      { method: "keyManagers.connections.signOut", parts: ["keyManagerConnections"] },
      { method: "keyManagers.connections.remove", parts: ["keyManagerConnections"] },
      { method: "keyManagers.move", parts: ["storedTokens"] },
    ]);
  });

  it("links the Key manager entry to the Forges and Memory bank steps and to About, where its Managed tools are (ADR 0026)", () => {
    expect(keyManager.links).toEqual([{ step: "forges" }, { step: "memory-bank" }, { row: "about.about" }]);
  });

  it("may skip the Key manager step, skipped when key-manager.present finds no connection, and never forces one (ADR 0028)", () => {
    expect(keyManager).toMatchObject({ skippable: true, skip: "key-manager.present" });
    expect(keyManager.stateChecks[0]).toEqual({ id: "key-manager.present", holds: "At least one key-manager connection is on this environment.", actions: [] });
  });

  it("checks that every connection is signed in and reachable, every injecting OpenBao login can mint, and each injecting connection's CLI is installed, with actions from ADR 0031's vocabulary (#383)", () => {
    expect(keyManager.stateChecks.map((check) => [check.id, check.actions])).toEqual([
      ["key-manager.present", []],
      ["key-manager.signed-in", ["sign-in-again"]],
      ["key-manager.reachable", ["check-again"]],
      ["key-manager.run-tokens", ["check-again"]],
      ["key-manager.cli", ["install", "update"]],
    ]);
    for (const check of keyManager.stateChecks) {
      for (const action of check.actions) expect(SETUP_ACTIONS as readonly string[], `${check.id}: ${action}`).toContain(action);
    }
    expect(keyManager.stateChecks.map((check) => check.holds)).toEqual([
      "At least one key-manager connection is on this environment.",
      "Every key-manager connection is signed in.",
      "Every key-manager connection is reachable, unsealed, and presents a certificate that verifies.",
      "Every injecting OpenBao connection's login can mint run tokens.",
      "Each injecting key-manager connection's CLI is installed at its minimum or later, bao or vault for OpenBao.",
    ]);
  });

  it("holds the Key manager entry's injection keys done on any value their schemas take, as a preference's", () => {
    const checkOf = (key: string) => keyManager.checks.find((check) => check.key === key)?.check;
    const presets = presetSettings();
    for (const key of CREDENTIAL_SETTINGS_KEYS) expect(checkOf(key)?.(presets[key]), key).toBe(true);
    expect(checkOf("credentials.injection")?.("deny")).toBe(true);
    expect(checkOf("credentials.injectionByAccount")?.({ "claude-max": "deny" })).toBe(true);
    expect(checkOf("credentials.injection")?.("inherit")).toEqual(refused("credentials.injection"));
    expect(checkOf("credentials.injectionByAccount")?.({ "claude-max": "inherit" })).toEqual(refused("credentials.injectionByAccount"));
  });

  it("registers the Memory bank entry sixth, after Key manager, at home on knowledge.banks, writing no settings key and its banks through banks.create, banks.join, banks.publish and banks.registry.update (setup spec, \"6. Memory bank\"; #586)", () => {
    const order = STEP_ORDER as readonly string[];
    expect(order.indexOf("memory-bank")).toBe(5);
    expect(order[order.indexOf("memory-bank") - 1]).toBe("key-manager");
    expect(memoryBank).toMatchObject({ home: "knowledge.banks", writes: [], checks: [] });
    expect(Object.values(SETTINGS).filter((setting) => setting.step.id === "memory-bank")).toEqual([]);
    expect(memoryBank.writesState).toEqual([
      { method: "banks.create", parts: ["banks"] },
      { method: "banks.join", parts: ["banks"] },
      { method: "banks.publish", parts: ["banks"] },
      { method: "banks.registry.update", parts: ["banks"] },
    ]);
  });

  it("links the Memory bank entry to the Key manager and Forges steps, with the git budget and the hour, and names the describe prompt in llm (ADR 0019)", () => {
    expect(memoryBank.links).toEqual([{ step: "key-manager" }, { step: "forges" }]);
    expect(memoryBank).toMatchObject({ budget: "git", cadence: { minutes: 60 }, llm: "describe-bank" });
    expect(STEP_PROMPTS.map((prompt) => prompt.id)).toContain("describe-bank");
  });

  it("may skip the Memory bank step, skipped when memory-bank.present finds no registered bank, then checks each bank reachable, its manifest, orientation, owners and landing", () => {
    expect(memoryBank).toMatchObject({ skippable: true, skip: "memory-bank.present" });
    expect(memoryBank.stateChecks).toEqual([
      { id: "memory-bank.present", holds: "At least one memory bank is registered on this environment.", actions: [] },
      { id: "memory-bank.reachable", holds: "Each enabled bank's remote answers, or its local repository exists.", actions: ["check-again"] },
      {
        id: "memory-bank.manifest",
        holds: "Each enabled bank's BANK.md on main passes the validator, or waits for review in an open pull request on a bank whose merges are reviewed.",
        actions: ["revise"],
      },
      { id: "memory-bank.orientation", holds: "Every orientation memory each enabled bank names exists.", actions: [] },
      { id: "memory-bank.owners", holds: "Each enabled team bank's owners resolve on its forge.", actions: [] },
      { id: "memory-bank.landing", holds: "No landing on an enabled bank has failed.", actions: ["check-again"] },
    ]);
  });

  it("holds the Your machines entry's update keys done on any value their schemas take, a pin included", () => {
    const checkOf = (key: string) => machines.checks.find((check) => check.key === key)?.check;
    const presets = presetSettings();
    for (const key of UPDATE_SETTINGS_KEYS) expect(checkOf(key)?.(presets[key]), key).toBe(true);
    expect(checkOf("updates.pinnedVersion")?.("0.4.2")).toBe(true);
    expect(checkOf("updates.idleWindowMinutes")?.(0)).toEqual(refused("updates.idleWindowMinutes"));
  });

  it("gives ADR 0031's three budget classes their seconds: five for a local read, ten for a network call, thirty for a git probe", () => {
    expect(CHECK_BUDGET_SECONDS).toEqual({ local: 5, network: 10, git: 30 });
  });

  it("gives Account, Carry over, Instructions, Browser, Permissions and Appearance the local budget, Your machines, Forges and Key manager the network one, Memory bank the git one, each an hourly cadence but Account, Forges and Key manager, checked every fifteen minutes because the orientation block reports each account's sign-in status and each forge account's and each connection's status", () => {
    expect(STEP_REGISTRY.map((step) => [step.id, step.budget, step.cadence.minutes])).toEqual([
      ["account", "local", 15],
      ["carry-over", "local", 60],
      ["your-machines", "network", 60],
      ["forges", "network", 15],
      ["key-manager", "network", 15],
      ["memory-bank", "git", 60],
      ["skills", "local", 60],
      ["instructions", "local", 60],
      ["browser", "local", 60],
      ["permissions", "local", 60],
      ["appearance", "local", 60],
    ]);
    expect(CHECK_BUDGET_SECONDS[forges.budget as keyof typeof CHECK_BUDGET_SECONDS]).toBe(10);
    expect(forges.cadence?.reason).toMatch(/orientation block reports each forge account's status/);
    expect(CHECK_BUDGET_SECONDS[keyManager.budget as keyof typeof CHECK_BUDGET_SECONDS]).toBe(10);
    expect(keyManager.cadence?.reason).toMatch(/orientation block reports each key-manager connection's status/);
    expect(account.cadence?.reason).toMatch(/orientation block reports each account's sign-in status/);
    for (const step of STEP_REGISTRY) if (!["account", "forges", "key-manager"].includes(step.id)) expect(step.cadence, step.id).toEqual({ minutes: 60 });
  });

  it("fails an entry with no budget, a budget outside ADR 0031's three classes, no cadence, a cadence of no whole minutes, or a cadence other than the hour with no reason", () => {
    const { budget, cadence, ...bare } = appearance;
    expect([budget, cadence]).toEqual(["local", { minutes: 60 }]);
    expect(stepShapeProblems([bare])).toEqual(["appearance: declares no budget", "appearance: declares no cadence"]);
    expect(stepShapeProblems([{ ...appearance, budget: "5" }])).toEqual(["appearance: a budget of 5 is not local, network or git"]);
    expect(stepShapeProblems([{ ...appearance, budget: "toString" }])).toEqual(["appearance: a budget of toString is not local, network or git"]);
    expect(stepShapeProblems([{ ...appearance, cadence: { minutes: 0.5 } }])).toEqual(["appearance: a cadence of 0.5 minutes is no whole number of minutes"]);
    expect(stepShapeProblems([{ ...appearance, cadence: { minutes: 15 } }])).toEqual(["appearance: a cadence of 15 minutes states no reason for leaving the hour"]);
    expect(stepShapeProblems([{ ...appearance, cadence: { minutes: 15, reason: " " } }])).toHaveLength(1);
    expect(stepShapeProblems([{ ...appearance, cadence: { minutes: 120 } }])).toEqual(["appearance: a cadence of 120 minutes states no reason for leaving the hour"]);
    expect(stepShapeProblems([{ ...appearance, budget: "git", cadence: { minutes: 15, reason: "The orientation block reports sign-in freshness." } }])).toEqual([]);
  });

  it("re-runs Account on account.updated and signin.updated, Carry over on account.updated, carry-over.imported and state-import.finished, Your machines on the update notices, settings.updated and the environment's name, icon and colour set (#323), Forges on every forge.account.* event and tools.updated, Key manager on every key-manager.* event and tools.updated, Memory bank on every bank.* event (#586), Skills on skills.updated, Instructions on its own events and every registry its orientation block reads, Browser on chrome.updated and extension.seen, Permissions on settings.updated and denylist.changed, and Appearance on settings.updated", () => {
    expect(STEP_REGISTRY.map((step) => [step.id, step.triggers])).toEqual([
      ["account", ["account.updated", "signin.updated"]],
      ["carry-over", ["account.updated", "carry-over.imported", "state-import.finished", "settings.changed"]],
      ["your-machines", ["environment.update-*", "settings.updated", "environment.renamed", "environment.icon-set", "environment.colour-set"]],
      ["forges", ["forge.account.*", "tools.updated"]],
      ["key-manager", ["key-manager.*", "tools.updated"]],
      ["memory-bank", ["bank.*"]],
      ["skills", ["skills.updated"]],
      ["instructions", ["bank.*", "instructions.*", "account.updated", "key-manager.*", "forge.account.*", "environment.renamed"]],
      ["browser", ["chrome.updated", "extension.seen"]],
      ["permissions", ["settings.updated", "denylist.changed"]],
      ["appearance", ["settings.updated"]],
    ]);
  });

  it("keeps the four feature steps' budgets and cadences, and resolves each trigger from #588 to a registered type", () => {
    for (const [id, budget, minutes] of [
      ["forges", "network", 15], ["key-manager", "network", 15], ["skills", "local", 60], ["instructions", "local", 60],
    ] as const) {
      const step = STEP_REGISTRY.find((entry) => entry.id === id)!;
      expect(step).toMatchObject({ budget, cadence: { minutes } });
      for (const trigger of step.triggers) {
        // #586 reserves bank.* for the bank event vocabulary arriving in #937.
        if (trigger === "bank.*") continue;
        expect(KNOWN_TYPES.some((type) => triggerMatches(trigger, type)), `${id}: ${trigger}`).toBe(true);
      }
    }
  });

  it("matches a trigger to its own type, and a family ending in * to every type it prefixes", () => {
    const matched = (trigger: string) => KNOWN_TYPES.filter((type) => triggerMatches(trigger, type));
    expect(matched("settings.updated")).toEqual(["settings.updated"]);
    expect(matched("environment.update-*")).toEqual(["environment.update-pending", "environment.update-started", "environment.update-failed", "environment.update-cancelled"]);
    expect(matched("forge.account.*")).toEqual([
      "forge.account.added",
      "forge.account.updated",
      "forge.account.primary-set",
      "forge.account.verified",
      "forge.account.capability-learned",
      "forge.account.git-rejected",
      "forge.account.removed",
    ]);
    expect(matched("bank.*")).toEqual([
      "bank.added",
      "bank.review-held",
      "bank.draft-queued",
      "bank.drafts-consumed",
      "bank.updated",
      "bank.pinned",
      "bank.forgotten",
      "bank.synced",
      "bank.verified",
      "bank.landed",
      "bank.landing-failed",
      "bank.awaiting-review",
    ]);
    expect(triggerMatches("settings.*", "settings.updated")).toBe(true);
    expect(triggerMatches("settings.updated*", "settings.updated")).toBe(true);
    expect(triggerMatches("settings", "settings.updated")).toBe(false);
    expect(triggerMatches("settings.updated", "settings.updated.late")).toBe(false);
    expect(triggerMatches("environment.*.started", "environment.update.started")).toBe(false);
  });

  it("fails an entry with no triggers, or a trigger that names, or as a family prefixes, no event or notice type", () => {
    const { triggers, ...bare } = appearance;
    expect(triggers).toEqual(["settings.updated"]);
    expect(stepShapeProblems([bare])).toEqual(["appearance: declares no triggers"]);
    expect(stepShapeProblems([{ ...appearance, triggers: [] }])).toEqual([]);
    expect(stepShapeProblems([{ ...appearance, triggers: ["settings.updated", "settings.changed", "appearance.theme-set", "theme.*", "environment.update"] }])).toEqual([
      "appearance: triggers on appearance.theme-set, which names no event or notice type",
      "appearance: triggers on theme.*, which prefixes no event or notice type",
      "appearance: triggers on environment.update, which names no event or notice type",
    ]);
    expect(stepShapeProblems([{ ...appearance, triggers: ["run.ended", "pairing.*", "account.*", "session.*"] }])).toEqual([]);
  });

  it("fails a step naming a prompt in llm that no prompt of STEP_PROMPTS has (ADR 0019; #584)", () => {
    expect(stepShapeProblems([{ ...appearance, llm: "appearance-describe" }])).toEqual(["appearance: names the prompt appearance-describe in llm, which is none of STEP_PROMPTS"]);
    expect(stepShapeProblems([{ ...appearance, llm: "appearance-describe" }], [{ id: "appearance-describe" }])).toEqual([]);
  });

  it("fails a skip check on a step that may not be skipped, a skippable step without one, and a skip check naming another step's check or none", () => {
    const present = { id: "account.present", holds: "At least one account is added.", actions: [] };
    expect(stepShapeProblems([{ ...account, skippable: true, stateChecks: [present], skip: "account.present" }])).toEqual([]);
    expect(stepShapeProblems([{ ...account, stateChecks: [present], skip: "account.present" }])).toEqual(["account: names the skip check account.present but may not be skipped"]);
    expect(stepShapeProblems([{ ...account, skippable: true, stateChecks: [present] }])).toEqual(["account: may be skipped but names no skip check"]);
    expect(stepShapeProblems([{ ...account, skippable: true, stateChecks: [present], skip: "permissions.not-root" }, permissions])).toEqual([
      "account: its skip check permissions.not-root is none of its state checks",
    ]);
    expect(stepShapeProblems([{ ...account, skippable: true, stateChecks: [present], skip: "account.missing" }])).toEqual([
      "account: its skip check account.missing is none of its state checks",
    ]);
  });

  it("fails a step out of the order or outside it, a link to no step or to itself, state through no method, a confirmation of an unwritten key, and a misnamed, doubled or unknown state check", () => {
    expect(stepShapeProblems([appearance, account])).toEqual(["account: registered out of the milestone-1 order"]);
    expect(stepShapeProblems([{ ...account, id: "housekeeping", stateChecks: [] }])).toEqual(["housekeeping: not a step of the milestone-1 order"]);
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

  it("fails a part of the state written through a step's own method that another step names too, so the denylist's four sections are the Permissions step's alone", () => {
    const browserSection = { ...account, writesState: [{ method: "permissions.denylist.set", parts: ["browserDomains"] }] };
    expect(stepShapeProblems([browserSection, permissions])).toEqual(["browserDomains: state written by account, permissions"]);
    expect(stepShapeProblems([{ ...account, writesState: [{ method: "permissions.denylist.get", parts: ["paths", "hosts"] }] }, permissions])).toEqual([
      "paths: state written by account, permissions",
      "hosts: state written by account, permissions",
    ]);
    expect(stepShapeProblems([{ ...account, writesState: [{ method: "permissions.denylist.set", parts: ["containment"] }] }, permissions])).toEqual([]);
  });

  it("puts the default account, model family and effort, the favourite models and providers.processIdleMinutes under the Account entry, on accounts.default-model, each checked done on any valid value", () => {
    const keys = ["accounts.defaultAccount", "accounts.defaultModelFamily", "accounts.defaultEffort", "accounts.favouriteModels", "providers.processIdleMinutes"] as const;
    expect(account.writes).toEqual(keys);
    expect(account.links).toEqual([{ row: "accounts.default-model" }]);
    for (const key of keys) expect(SETTINGS[key].step, key).toEqual({ id: "account", row: "accounts.default-model" });
    const checkOf = (key: string) => (account.checks.find((entry) => entry.key === key) as LooseStep["checks"][number]).check;
    for (const key of keys.slice(0, 3)) {
      expect(checkOf(key)(null), key).toBe(true);
      expect(checkOf(key)("opus"), key).toBe(true);
      expect(checkOf(key)(""), key).toEqual(refused(key));
    }
    expect(checkOf("accounts.favouriteModels")([])).toBe(true);
    expect(checkOf("accounts.favouriteModels")(["opus", "sonnet"])).toBe(true);
    expect(checkOf("accounts.favouriteModels")(["opus", "opus"])).toEqual(refused("accounts.favouriteModels"));
    const check = checkOf("providers.processIdleMinutes");
    expect(check(presetSettings()["providers.processIdleMinutes"])).toBe(true);
    expect(check(1440)).toBe(true);
    expect(check(0)).toEqual(refused("providers.processIdleMinutes"));
  });

  it("gives the Account entry account.present, with no action since the card's Sign in is the fix, and account.signed-in, with Sign in again, and never skips it (ADR 0018; #574)", () => {
    expect(account.stateChecks).toEqual([
      { id: "account.present", holds: "At least one account is on this environment.", actions: [] },
      { id: "account.signed-in", holds: "Every account on this environment is signed in.", actions: ["sign-in-again", "check-again"] },
    ]);
    expect(account.skippable).toBe(false);
    expect(account.skip).toBeUndefined();
  });

  it("fails when a settings key names no entry, or no entry writes it", () => {
    const added = { ...settings, "sessions.autoArchive": { step: { id: "housekeeping", row: "environments.service" } } };
    expect(stepRegistryProblems(added, steps)).toEqual([
      "sessions.autoArchive: names the step housekeeping, which is not registered",
      "sessions.autoArchive: no step writes it",
    ]);
    const unwritten = { ...settings, "sessions.autoArchive": { step: { id: "appearance", row: "environments.service" } } };
    expect(stepRegistryProblems(unwritten, steps)).toEqual(["sessions.autoArchive: no step writes it"]);
  });

  it("fails when a key is written by a step other than the one it names, or by two", () => {
    const other: LooseStep = { id: "permissions", writes: ["sessions.autoSettleOnMerge"], checks: [], stateChecks: [], links: [], skippable: false };
    const withoutMerge = {
      ...sessionsStep,
      writes: sessionsStep.writes.filter((key) => key !== "sessions.autoSettleOnMerge"),
      checks: sessionsStep.checks.filter((check) => check.key !== "sessions.autoSettleOnMerge"),
    };
    expect(stepRegistryProblems(sessionSettings, [withoutMerge, other])).toEqual([
      "sessions.autoSettleOnMerge: names your-machines but permissions writes it",
      "permissions: needs one health check of sessions.autoSettleOnMerge",
    ]);
    expect(stepRegistryProblems(sessionSettings, [sessionsStep, { ...other, checks: [sessionsStep.checks[1] as LooseStep["checks"][number]] }])).toEqual([
      "sessions.autoSettleOnMerge: written by your-machines, permissions",
    ]);
  });

  it("fails when a step writes a key that is not a setting, or writes a key it does not check", () => {
    expect(stepRegistryProblems(sessionSettings, [{ ...sessionsStep, writes: [...sessionsStep.writes, "sessions.autoArchive"] }])).toEqual([
      "your-machines: writes sessions.autoArchive, which is not a setting",
      "your-machines: needs one health check of sessions.autoArchive",
    ]);
    expect(stepRegistryProblems(sessionSettings, [{ ...sessionsStep, checks: [] }])).toEqual([
      "your-machines: needs one health check of sessions.autoSettleAfterIdle",
      "your-machines: needs one health check of sessions.autoSettleOnMerge",
      "your-machines: needs one health check of sessions.transcriptCompactAfterDays",
    ]);
    expect(stepRegistryProblems(sessionSettings, [sessionsStep, sessionsStep])).toEqual([
      "your-machines: registered twice",
      "sessions.autoSettleAfterIdle: written by your-machines, your-machines",
      "sessions.autoSettleOnMerge: written by your-machines, your-machines",
      "sessions.transcriptCompactAfterDays: written by your-machines, your-machines",
    ]);
  });

  it("checks each key done on any valid value, the preset included, and names the key when it is not", () => {
    const check = (key: SettingsKey) => (machines.checks.find((entry) => entry.key === key) as LooseStep["checks"][number]).check;
    const presets = presetSettings();
    for (const key of AUTO_SETTLE_KEYS) expect(check(key)(presets[key]), key).toBe(true);
    for (const value of [null, { amount: 1, unit: "days" }, { amount: 3, unit: "weeks" }, { amount: 1000, unit: "months" }]) {
      expect(check("sessions.autoSettleAfterIdle")(value), JSON.stringify(value)).toBe(true);
    }
    expect(check("sessions.autoSettleOnMerge")(true)).toBe(true);
    expect(check("sessions.transcriptCompactAfterDays")(1)).toBe(true);
    expect(check("sessions.transcriptCompactAfterDays")(0)).toEqual(refused("sessions.transcriptCompactAfterDays"));
    expect(check("sessions.autoSettleAfterIdle")({ amount: 0, unit: "days" })).toEqual(refused("sessions.autoSettleAfterIdle"));
    expect(check("sessions.autoSettleOnMerge")("yes")).toEqual(refused("sessions.autoSettleOnMerge"));
  });
});

/** The switch-over gate adds completeness to the incremental registry's contracts. */
const switchOverRegistryProblems = (steps: readonly LooseStep[]): string[] => [
  ...unregisteredSteps(steps).map((id) => `${id}: required for switch-over`),
  ...steps.filter((step) => step.stateChecks.length === 0).map((step) => `${step.id}: declares no Health checks`),
  ...stepShapeProblems(steps),
  ...stepRegistryProblems(SETTINGS, steps),
];

/** Switch-over makes the incrementally built registry a complete contract (#1192). */
describe("the switch-over's complete Set up registry", () => {
  it("requires all eleven ids in the specified order and the existing shape and settings contracts", () => {
    expect(STEP_ORDER).toEqual(["account", "carry-over", "your-machines", "forges", "key-manager", "memory-bank", "skills", "instructions", "browser", "permissions", "appearance"]);
    expect(STEP_REGISTRY.map((step) => step.id)).toEqual(STEP_ORDER);
    expect(REGISTERED_STEP_IDS).toEqual(STEP_ORDER);
    for (const step of STEP_REGISTRY) expect(settingsRow(step.home).homeOf, step.id).toContain(step.id);
    expect(switchOverRegistryProblems(STEP_REGISTRY)).toEqual([]);
    expect(unregisteredSteps()).toEqual([]);
  });

  it.each(STEP_ORDER)("blocks switch-over when %s is absent, including steps with no settings writes", (id) => {
    const incomplete = STEP_REGISTRY.filter((step) => step.id !== id);
    expect(switchOverRegistryProblems(incomplete)).toContain(`${id}: required for switch-over`);
  });

  it.each(STEP_ORDER)("blocks switch-over when %s has no declared Health checks", (id) => {
    const unchecked = STEP_REGISTRY.map((step) => step.id === id ? { ...step, stateChecks: [] } : step);
    expect(switchOverRegistryProblems(unchecked)).toContain(`${id}: declares no Health checks`);
  });
});

describe("switch-over's import contract readiness", () => {
  it("registers import methods at exactly one scope each, with no owed handler behind stateImport", () => {
    expect(Object.values(registry).filter((method) => method.name.startsWith("stateImport.")).map((method) => [method.name, method.kind, method.scope])).toEqual([
      ["stateImport.detect", "query", "read"],
      ["stateImport.run", "command", "admin"],
    ]);
    expect(Object.keys(OWED_HANDLERS).filter((name) => name.startsWith("stateImport."))).toEqual([]);
  });
});
