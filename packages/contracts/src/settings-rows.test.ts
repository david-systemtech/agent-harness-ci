import { describe, expect, expectTypeOf, it } from "vitest";
import {
  ADDRESS_ROWS,
  AUTO_SETTLE_KEYS,
  PERMISSION_SETTINGS_KEYS,
  SETTINGS,
  SETTINGS_ADDRESSES,
  SETTINGS_BANDS,
  SETTINGS_ROWS,
  STEP_ORDER,
  STEP_REGISTRY,
  SettingsRow,
  UPDATE_SETTINGS_KEYS,
  isSettingsAddress,
  readStoredRow,
  rowOfAddress,
  type SettingsAddress,
  type SettingsRowId,
} from "./index.js";

/**
 * The row registry's contract test (ADR 0027; GUI spec, "Settings: the rail,
 * the rows and the addresses"): the eight bands in their order, each row's
 * label, scope and the steps it is home to as the spec's table holds them;
 * every settings key on a row its step reaches, and every step on one home
 * row that lists it. Each check is a plain function over the tables, so each
 * failure it exists to catch is shown failing on a table broken on purpose.
 */

/** A row as the check reads it, typed loosely so a broken one can be written. */
interface LooseRow {
  readonly id: string;
  readonly homeOf: string | readonly string[];
}

/** A step as the check reads it: its home row and its links. */
interface LooseStep {
  readonly id: string;
  readonly home?: string;
  readonly links: readonly ({ readonly row: string } | { readonly step: string })[];
}

/** A settings table as the check reads it: the step that writes each key and the row it sits on. */
type LooseSettings = Readonly<Record<string, { readonly step: { readonly id: string; readonly row?: string } }>>;

/** The steps a row is home to; none for the Set up row, which is home to the whole checklist. */
const homedBy = (row: LooseRow): readonly string[] => (typeof row.homeOf === "string" ? [] : row.homeOf);

/** What is wrong with the rows, the steps and the settings together. */
const rowProblems = (rows: readonly LooseRow[], steps: readonly LooseStep[], settings: LooseSettings): string[] => {
  const problems: string[] = [];
  const ids = rows.map((row) => row.id);
  const isRow = (id: string) => ids.includes(id);
  const order = STEP_ORDER as readonly string[];
  for (const id of new Set(ids)) if (ids.filter((other) => other === id).length > 1) problems.push(`${id}: registered twice`);
  for (const row of rows) {
    if (typeof row.homeOf === "string" && row.homeOf !== "checklist") problems.push(`${row.id}: home to ${row.homeOf}, which is not the checklist`);
    for (const step of homedBy(row)) if (!order.includes(step)) problems.push(`${row.id}: home to ${step}, which is not a step of the milestone-1 order`);
  }
  for (const step of order) {
    const homes = rows.filter((row) => homedBy(row).includes(step)).map((row) => row.id);
    if (homes.length === 0) problems.push(`${step}: no row is home to it`);
    else if (homes.length > 1) problems.push(`${step}: home rows ${homes.join(", ")}`);
  }
  for (const step of steps) {
    if (step.home === undefined) problems.push(`${step.id}: names no home row`);
    else if (!isRow(step.home)) problems.push(`${step.id}: lives on ${step.home}, which is not a row`);
    else if (!homedBy(rows.find((row) => row.id === step.home) as LooseRow).includes(step.id)) problems.push(`${step.id}: lives on ${step.home}, which is not home to it`);
    for (const link of step.links) if ("row" in link && !isRow(link.row)) problems.push(`${step.id}: links to ${link.row}, which is not a row`);
  }
  for (const [key, { step: place }] of Object.entries(settings)) {
    if (place.row === undefined) {
      problems.push(`${key}: sits on no row`);
      continue;
    }
    if (!isRow(place.row)) problems.push(`${key}: sits on ${place.row}, which is not a row`);
    const step = steps.find((entry) => entry.id === place.id);
    const reached = step === undefined ? [] : [step.home, ...step.links.flatMap((link) => ("row" in link ? [link.row] : []))];
    if (step !== undefined && !reached.includes(place.row)) problems.push(`${key}: sits on ${place.row}, which ${step.id} neither lives on nor links to`);
  }
  return problems;
};

const rows = SETTINGS_ROWS as readonly LooseRow[];
const steps = STEP_REGISTRY as readonly LooseStep[];
const settings = SETTINGS as LooseSettings;
const stepOf = (id: string): LooseStep => steps.find((step) => step.id === id) as LooseStep;

describe("the row registry", () => {
  it("holds the eight bands in ADR 0027's order", () => {
    expect(SETTINGS_BANDS.map((band) => [band.id, band.label])).toEqual([
      ["setup", "Set up"],
      ["accounts", "Accounts"],
      ["knowledge", "Knowledge"],
      ["access", "Access"],
      ["routines", "Routines and bots"],
      ["environments", "Environments"],
      ["appearance", "Appearance"],
      ["about", "About"],
    ]);
  });

  it("holds the spec's rows in band order, each with its label, scope and the steps it is home to", () => {
    expect(SETTINGS_ROWS.map((row) => [row.id, row.label, row.scope, row.homeOf])).toEqual([
      ["setup.checklist", "Set up", "environment", "checklist"],
      ["accounts.accounts", "Accounts", "environment", ["account", "carry-over"]],
      ["accounts.default-model", "Default account and model", "environment", []],
      ["accounts.usage", "Usage", "everywhere", []],
      ["knowledge.banks", "Memory banks", "environment", ["memory-bank"]],
      ["knowledge.skills", "Skills", "environment", ["skills"]],
      ["knowledge.instructions", "Instructions", "environment", ["instructions"]],
      ["access.permissions", "Permissions", "environment", ["permissions"]],
      ["access.browser", "Browser", "environment", ["browser"]],
      ["access.key-managers", "Key managers", "environment", ["key-manager"]],
      ["access.forges", "Forges", "environment", ["forges"]],
      // The routines spec's chosen default: the row lists every environment's routines (#301 aligns the GUI spec).
      ["routines.routines", "Routines", "everywhere", []],
      ["routines.bots", "Bots", "environment", []],
      ["environments.machines", "Your machines", "everywhere", ["your-machines"]],
      ["environments.access", "Access", "environment", []],
      ["environments.service", "Service", "environment", []],
      ["appearance.theme", "Theme", "client", ["appearance"]],
      ["appearance.shortcuts", "Keyboard shortcuts", "client", []],
      ["about.about", "About", "environment", []],
    ]);
  });

  it("names each row band.row within its own band, one line of hint each, every entry valid against the published shape", () => {
    const bands = SETTINGS_BANDS.map((band) => band.id) as readonly string[];
    for (const row of SETTINGS_ROWS) {
      expect(row.id.startsWith(`${row.band}.`), row.id).toBe(true);
      expect(row.hint, row.id).toMatch(/^[^\n]+\.$/);
      expect(SettingsRow.safeParse(row).success, row.id).toBe(true);
    }
    // In band order: no band's rows come after a later band's.
    const order = SETTINGS_ROWS.map((row) => bands.indexOf(row.band));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(new Set(SETTINGS_ROWS.map((row) => row.band))).toEqual(new Set(bands));
  });

  it("draws routines.bots dim until milestone 2, with its reason, and no other row", () => {
    expect(SETTINGS_ROWS.filter((row) => "dim" in row).map((row) => row.id)).toEqual(["routines.bots"]);
    expect(SETTINGS_ROWS.find((row) => row.id === "routines.bots")).toMatchObject({ dim: expect.stringMatching(/milestone 2/) });
  });
});

describe("keys and steps on rows", () => {
  it("has every settings key on a row its step lives on or links to, and every step on the one home row that lists it", () => {
    expect(rowProblems(rows, steps, settings)).toEqual([]);
  });

  it("homes each step as the GUI spec's table does, the Set up row home to the checklist, and keeps a step's links to other steps", () => {
    expect(STEP_REGISTRY.map((step) => [step.id, step.home])).toEqual([
      ["account", "accounts.accounts"],
      ["carry-over", "accounts.accounts"],
      ["your-machines", "environments.machines"],
      ["forges", "access.forges"],
      ["key-manager", "access.key-managers"],
      ["memory-bank", "knowledge.banks"],
      ["skills", "knowledge.skills"],
      ["instructions", "knowledge.instructions"],
      ["browser", "access.browser"],
      ["permissions", "access.permissions"],
      ["appearance", "appearance.theme"],
    ]);
    const homes = Object.fromEntries(STEP_ORDER.map((step) => [step, rows.find((row) => homedBy(row).includes(step))?.id]));
    expect(homes).toEqual({
      account: "accounts.accounts",
      "carry-over": "accounts.accounts",
      "your-machines": "environments.machines",
      forges: "access.forges",
      "key-manager": "access.key-managers",
      "memory-bank": "knowledge.banks",
      skills: "knowledge.skills",
      instructions: "knowledge.instructions",
      browser: "access.browser",
      permissions: "access.permissions",
      appearance: "appearance.theme",
    });
    expect(stepOf("permissions").links).toEqual([{ step: "your-machines" }]);
  });

  it("puts the Account step's five keys on accounts.default-model, which its step links to beside its home", () => {
    const keys = ["accounts.defaultAccount", "accounts.defaultModelFamily", "accounts.defaultEffort", "accounts.favouriteModels", "providers.processIdleMinutes"] as const;
    for (const key of keys) expect(SETTINGS[key].step, key).toEqual({ id: "account", row: "accounts.default-model" });
    expect(stepOf("account").links).toEqual([{ row: "accounts.default-model" }]);
  });

  it("puts the permission keys on access.permissions and the launcher's update keys on environments.machines, their steps' homes", () => {
    for (const key of PERMISSION_SETTINGS_KEYS) expect(SETTINGS[key].step, key).toEqual({ id: "permissions", row: "access.permissions" });
    for (const key of UPDATE_SETTINGS_KEYS) expect(SETTINGS[key].step, key).toEqual({ id: "your-machines", row: "environments.machines" });
  });

  it("puts the two auto-settle keys and the compaction window on environments.service, written by the Your machines step, which links there, and no longer by Appearance", () => {
    for (const key of [...AUTO_SETTLE_KEYS, "sessions.transcriptCompactAfterDays" as const]) {
      expect(SETTINGS[key].step, key).toEqual({ id: "your-machines", row: "environments.service" });
    }
    expect(stepOf("your-machines").links).toEqual([{ row: "environments.service" }]);
    expect(stepOf("appearance").links).toEqual([]);
  });

  it("fails a settings key without a row, on no registered row, or on a row its step does not reach", () => {
    const place = (id: string, row?: string) => ({ step: { id, ...(row !== undefined && { row }) } });
    expect(rowProblems(rows, steps, { ...settings, "sessions.autoArchive": place("appearance") })).toEqual(["sessions.autoArchive: sits on no row"]);
    expect(rowProblems(rows, steps, { ...settings, "sessions.autoArchive": place("appearance", "appearance.sessions") })).toEqual([
      "sessions.autoArchive: sits on appearance.sessions, which is not a row",
      "sessions.autoArchive: sits on appearance.sessions, which appearance neither lives on nor links to",
    ]);
    expect(rowProblems(rows, steps, { ...settings, "sessions.autoArchive": place("appearance", "about.about") })).toEqual([
      "sessions.autoArchive: sits on about.about, which appearance neither lives on nor links to",
    ]);
  });

  it("fails a step without a home row, on no registered row, on a row not home to it, or linking to no row", () => {
    const account = stepOf("account");
    const homeless: LooseStep = { id: account.id, links: account.links };
    expect(rowProblems(rows, [homeless, ...steps.slice(1)], settings)).toEqual(["account: names no home row"]);
    expect(rowProblems(rows, [{ ...account, home: "accounts.profiles" }, ...steps.slice(1)], settings)).toEqual(["account: lives on accounts.profiles, which is not a row"]);
    expect(rowProblems(rows, [{ ...account, home: "accounts.default-model" }, ...steps.slice(1)], settings)).toEqual([
      "account: lives on accounts.default-model, which is not home to it",
    ]);
    expect(rowProblems(rows, [{ ...account, links: [{ row: "accounts.models" }] }, ...steps.slice(1)], settings)).toEqual([
      "account: links to accounts.models, which is not a row",
      "accounts.defaultAccount: sits on accounts.default-model, which account neither lives on nor links to",
      "accounts.defaultModelFamily: sits on accounts.default-model, which account neither lives on nor links to",
      "accounts.defaultEffort: sits on accounts.default-model, which account neither lives on nor links to",
      "accounts.favouriteModels: sits on accounts.default-model, which account neither lives on nor links to",
      "providers.processIdleMinutes: sits on accounts.default-model, which account neither lives on nor links to",
    ]);
  });

  it("fails a row home to a step another row homes, a step no row homes, a row naming a step outside the milestone-1 order, and a row registered twice", () => {
    const withHome = (id: string, homeOf: LooseRow["homeOf"]) => rows.map((row) => (row.id === id ? { ...row, homeOf } : row));
    expect(rowProblems(withHome("accounts.default-model", ["account"]), steps, settings)).toEqual(["account: home rows accounts.accounts, accounts.default-model"]);
    expect(rowProblems(withHome("knowledge.skills", []), steps, settings)).toEqual(["skills: no row is home to it", "skills: lives on knowledge.skills, which is not home to it"]);
    expect(rowProblems(withHome("routines.routines", ["routines"]), steps, settings)).toEqual(["routines.routines: home to routines, which is not a step of the milestone-1 order"]);
    expect(rowProblems(withHome("about.about", "everything"), steps, settings)).toEqual(["about.about: home to everything, which is not the checklist"]);
    expect(rowProblems([...rows, { id: "about.about", homeOf: [] }], steps, settings)).toEqual(["about.about: registered twice"]);
  });
});

describe("the sixteen settings addresses", () => {
  it("are a closed union of the existing addresses, mapped to rows as the GUI spec's table maps them", () => {
    expect(SETTINGS_ADDRESSES).toEqual([
      "profiles",
      "models",
      "runs",
      "agents",
      "skills",
      "memory-banks",
      "cerebro",
      "permissions",
      "browser",
      "secrets",
      "server",
      "remote",
      "routines",
      "advanced",
      "appearance",
      "about",
    ]);
    expect(Object.fromEntries(SETTINGS_ADDRESSES.map((address) => [address, rowOfAddress(address)]))).toEqual({
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
    expect(Object.keys(ADDRESS_ROWS)).toEqual([...SETTINGS_ADDRESSES]);
  });

  it("tell a stored section that is one of them from one that is not, for the state import to map", () => {
    expect(SETTINGS_ADDRESSES.every((address) => isSettingsAddress(address))).toBe(true);
    for (const other of ["settings", "key-managers", "access.key-managers", "Secrets", "", null, 3]) expect(isSettingsAddress(other), JSON.stringify(other)).toBe(false);
  });

  it("are mapped exhaustively at compile time: a table missing an address, or naming one that is not, does not compile", () => {
    type Table = { readonly [A in SettingsAddress]: SettingsRowId };
    expectTypeOf(ADDRESS_ROWS).toExtend<Table>();
    // A table lacking `about` is not one.
    expectTypeOf<Omit<typeof ADDRESS_ROWS, "about">>().not.toExtend<Table>();
    // @ts-expect-error: `settings` is not one of the sixteen addresses.
    const long: Table = { ...ADDRESS_ROWS, settings: "about.about" };
    // @ts-expect-error: an address maps to a registered row.
    const wrong: Table = { ...ADDRESS_ROWS, about: "about.version" };
    expect([long, wrong]).toHaveLength(2);
  });

  it("are search terms of the rows they map to, the split parts on their second rows too: secrets finds Key managers and cerebro Memory banks", () => {
    const termsOf = (id: string) => (SETTINGS_ROWS.find((row) => row.id === id)?.terms ?? []) as readonly string[];
    for (const address of SETTINGS_ADDRESSES) expect(termsOf(rowOfAddress(address)), address).toContain(address);
    expect(termsOf("access.key-managers")).toContain("secrets");
    expect(termsOf("knowledge.banks")).toContain("cerebro");
    // Runs' speed moved to Default account and model, and Advanced's service verbs to Service (ADR 0027).
    expect(termsOf("accounts.default-model")).toContain("runs");
    expect(termsOf("environments.service")).toContain("advanced");
  });
});

describe("a stored row id", () => {
  it("reads as the row it names when the registry holds it, and as setup.checklist otherwise", () => {
    for (const row of SETTINGS_ROWS) expect(readStoredRow(row.id)).toBe(row.id);
    for (const stored of ["accounts.models", "secrets", "", "Access.Permissions", null, undefined, 3, { id: "access.permissions" }]) {
      expect(readStoredRow(stored), JSON.stringify(stored)).toBe("setup.checklist");
    }
  });
});
