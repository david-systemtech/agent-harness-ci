import { z } from "zod";
import { StepId } from "./steps.js";

/**
 * The row registry (ADR 0027; GUI spec, "Settings: the rail, the rows and
 * the addresses"): Settings is eight bands of rows, and every row is
 * registered here with its id (`band.row`), band, label, one-line hint,
 * scope, the steps it is home to, and the search terms that find it, its old
 * addresses and section names among them. Every settings key names the row
 * it sits on (`settings.ts`), and every step its home row (`steps.ts`), so
 * the GUI's rail, the terminal UI's `/settings` and a client in another
 * language land on the same rows. The contract test (`settings-rows.test.ts`)
 * fails a key without a row, a step without a home row, a step homed twice,
 * and a row naming a step outside the milestone-1 order.
 */

/** The eight bands, in the rail's order (ADR 0027). */
export const SETTINGS_BANDS = [
  { id: "setup", label: "Set up" },
  { id: "accounts", label: "Accounts" },
  { id: "knowledge", label: "Knowledge" },
  { id: "access", label: "Access" },
  { id: "routines", label: "Routines and bots" },
  { id: "environments", label: "Environments" },
  { id: "appearance", label: "Appearance" },
  { id: "about", label: "About" },
] as const;

export type SettingsBandId = (typeof SETTINGS_BANDS)[number]["id"];
export const SettingsBandId = z
  .enum(SETTINGS_BANDS.map((band) => band.id) as [SettingsBandId, ...SettingsBandId[]])
  .meta({ description: "A band of Settings, in the rail's order: setup, accounts, knowledge, access, routines (Routines and bots), environments, appearance, about." });

export const SettingsBand = z
  .object({ id: SettingsBandId, label: z.string().min(1).meta({ description: "The band's heading on the rail." }) })
  .meta({ description: "One of the eight bands of Settings: its id and the heading the rail draws." });
export type SettingsBand = z.infer<typeof SettingsBand>;

/**
 * What a row's pane edits (ADR 0027): one environment, picked in its header
 * (`environment`); every environment at once, grouped by environment, with no
 * picker (`everywhere`); or this client alone, with no picker (`client`).
 */
export const SETTINGS_ROW_SCOPES = ["environment", "everywhere", "client"] as const;
export const SettingsRowScope = z.enum(SETTINGS_ROW_SCOPES).meta({
  description:
    "What a row's pane edits: environment (one environment, chosen by the picker in its header, preset to the home environment), everywhere (every environment at once, grouped by environment, no picker) or client (this client alone, no picker).",
});
export type SettingsRowScope = z.infer<typeof SettingsRowScope>;

/** What the Set up row is home to: the whole checklist rather than a step of it. */
export const WHOLE_CHECKLIST = "checklist";

/** One row as the registry writes it; `SettingsRow` is its schema. */
interface RowEntry {
  readonly id: `${SettingsBandId}.${string}`;
  readonly band: SettingsBandId;
  readonly label: string;
  readonly hint: string;
  readonly scope: SettingsRowScope;
  readonly homeOf: typeof WHOLE_CHECKLIST | readonly StepId[];
  readonly terms: readonly string[];
  readonly dim?: string;
}

/**
 * Every row, in the rail's order: the GUI spec's table, with its labels and
 * scopes, but the Routines row `everywhere`, as the routines spec chose (it
 * lists every environment's routines; #301 aligns the GUI spec's text). A
 * row's search terms carry the old settings addresses that map onto it
 * (`ADDRESS_ROWS`) and the names of the sections it absorbed; search also
 * matches its id, label and hint.
 */
export const SETTINGS_ROWS = [
  {
    id: "setup.checklist",
    band: "setup",
    label: "Set up",
    hint: "Every step of the checklist on the environment picked, with its health and a link to the row it lives on.",
    scope: "environment",
    homeOf: WHOLE_CHECKLIST,
    terms: ["checklist", "wizard"],
  },
  {
    id: "accounts.accounts",
    band: "accounts",
    label: "Accounts",
    hint: "The provider accounts runs use: adopt, sign in, relabel or remove one, and carry over what it holds.",
    scope: "environment",
    homeOf: ["account", "carry-over"],
    terms: ["profiles", "profile", "sign in", "carry over"],
  },
  {
    id: "accounts.default-model",
    band: "accounts",
    label: "Default account and model",
    hint: "The account, model family and effort a new session starts on.",
    scope: "environment",
    homeOf: [],
    terms: ["models", "runs", "speed", "effort", "quick access", "catalogue"],
  },
  {
    id: "accounts.usage",
    band: "accounts",
    label: "Usage",
    hint: "Every account's plan windows, pooled across environments, and the hand-off threshold.",
    scope: "everywhere",
    homeOf: [],
    terms: ["runs", "spend", "hand-off"],
  },
  {
    id: "knowledge.banks",
    band: "knowledge",
    label: "Memory banks",
    hint: "The memory banks runs read and write, each with its role and orientation.",
    scope: "environment",
    homeOf: ["memory-bank"],
    terms: ["memory-banks", "cerebro", "memory"],
  },
  {
    id: "knowledge.skills",
    band: "knowledge",
    label: "Skills",
    hint: "Skill sources, their sync, and the skills each account runs with.",
    scope: "environment",
    homeOf: ["skills"],
    terms: ["skills", "skill sources"],
  },
  {
    id: "knowledge.instructions",
    band: "knowledge",
    label: "Instructions",
    hint: "The standing instructions runs receive, beside the orientation block.",
    scope: "environment",
    homeOf: ["instructions"],
    terms: ["agents", "orientation"],
  },
  {
    id: "access.permissions",
    band: "access",
    label: "Permissions",
    hint: "The default ceiling, the unattended mode, parked prompts, containment and the denylist.",
    scope: "environment",
    homeOf: ["permissions"],
    terms: ["permissions", "denylist", "containment", "unattended"],
  },
  {
    id: "access.browser",
    band: "access",
    label: "Browser",
    hint: "The Chrome paired with this environment through the extension, and the sites runs may reach.",
    scope: "environment",
    homeOf: ["browser"],
    terms: ["browser", "chrome", "extension"],
  },
  {
    id: "access.key-managers",
    band: "access",
    label: "Key managers",
    hint: "The key managers runs take their secrets from, and stored tokens to move into one.",
    scope: "environment",
    homeOf: ["key-manager"],
    terms: ["secrets", "tokens"],
  },
  {
    id: "access.forges",
    band: "access",
    label: "Forges",
    hint: "The forge accounts runs clone, push and open pull requests with, and the primary forge.",
    scope: "environment",
    homeOf: ["forges"],
    terms: ["github", "git", "pull requests"],
  },
  {
    id: "routines.routines",
    band: "routines",
    label: "Routines",
    hint: "Every environment's routines, with their schedules, history and health.",
    scope: "everywhere",
    homeOf: [],
    terms: ["routines", "schedules"],
  },
  {
    id: "routines.bots",
    band: "routines",
    label: "Bots",
    hint: "The bots that own routines, and what each may do.",
    scope: "environment",
    homeOf: [],
    terms: ["bots"],
    dim: "Bots arrive in milestone 2, with the Bot object.",
  },
  {
    id: "environments.machines",
    band: "environments",
    label: "Your machines",
    hint: "Every environment: its name, version, channel and updates, workspace folders, and adding a machine.",
    scope: "everywhere",
    homeOf: ["your-machines"],
    terms: ["remote", "advanced", "this machine", "updates", "workspace folders"],
  },
  {
    id: "environments.access",
    band: "environments",
    label: "Access",
    hint: "The client sessions and program pairings that reach this environment, their ceilings, and the access log.",
    scope: "environment",
    homeOf: [],
    terms: ["server", "program pairings", "client sessions", "access log"],
  },
  {
    id: "environments.service",
    band: "environments",
    label: "Service",
    hint: "The environment's service, draining it, and how long sessions stay before they settle or compact.",
    scope: "environment",
    homeOf: [],
    terms: ["advanced", "drain", "sessions", "auto-settle", "compaction"],
  },
  {
    id: "appearance.theme",
    band: "appearance",
    label: "Theme",
    hint: "Light or dark, text size and reading width, and the home environment's theme.",
    scope: "client",
    homeOf: ["appearance"],
    terms: ["appearance", "dark mode", "colours"],
  },
  {
    id: "appearance.shortcuts",
    band: "appearance",
    label: "Keyboard shortcuts",
    hint: "Every named action's keys in this client, with remapping.",
    scope: "client",
    homeOf: [],
    terms: ["keybindings", "keys", "hotkeys"],
  },
  {
    id: "about.about",
    band: "about",
    label: "About",
    hint: "This client's version, then the picked environment's version, channel, auto-update and managed tools.",
    scope: "environment",
    homeOf: [],
    terms: ["about", "version", "managed tools"],
  },
] as const satisfies readonly RowEntry[];

export type SettingsRowId = (typeof SETTINGS_ROWS)[number]["id"];

/** Every row's id, in the rail's order. */
export const SETTINGS_ROW_IDS = SETTINGS_ROWS.map((row) => row.id) as [SettingsRowId, ...SettingsRowId[]];

export const SettingsRowId = z.enum(SETTINGS_ROW_IDS).meta({ description: `A row of Settings, by its id (band.row): ${SETTINGS_ROW_IDS.join(", ")}.` });

/**
 * One row of the registry. That the id's first part is the row's band is
 * zod's rule only; a client in another language checks it itself.
 */
export const SettingsRow = z
  .object({
    id: SettingsRowId,
    band: SettingsBandId,
    label: z.string().min(1).meta({ description: "The row's name on the rail and its pane's heading." }),
    hint: z.string().min(1).meta({ description: "One line saying what the row holds, under its label and in search." }),
    scope: SettingsRowScope,
    homeOf: z.union([
      z.literal(WHOLE_CHECKLIST).meta({ description: "The Set up row: home to the whole checklist, its dot the worst of every step's." }),
      z.array(StepId).meta({ description: "The steps whose home row this is, whose health its dot shows; empty for a row no step lives on." }),
    ]),
    terms: z.array(z.string().min(1)).meta({ description: "What else search finds the row by: the old settings addresses that map onto it and the names of the sections it absorbed." }),
    dim: z.string().min(1).optional().meta({ description: "Present on a placeholder row drawn dim: why it is dim." }),
  })
  .superRefine((row, ctx) => {
    if (!row.id.startsWith(`${row.band}.`)) ctx.addIssue({ code: "custom", path: ["band"], message: `${row.id} is a row of the band ${row.id.slice(0, row.id.indexOf("."))}.` });
  })
  .meta({
    description:
      "One row of Settings: its id (band.row, the band its first part), band, label, one-line hint, scope, the steps it is home to (or the whole checklist, for Set up), the search terms that find it, and why it is dim when it is a placeholder.",
  });
export type SettingsRow = z.infer<typeof SettingsRow>;

/** The row Settings opens on when nothing better is known: Set up, the first row, which cannot be hidden (ADR 0027). */
export const FIRST_ROW = "setup.checklist" satisfies SettingsRowId;

/** Whether `value` is the id of a row the registry holds. */
export const isSettingsRowId = (value: unknown): value is SettingsRowId => (SETTINGS_ROW_IDS as readonly unknown[]).includes(value);

/**
 * A stored row id (the last row opened, kept by a client) read against the
 * registry: the row it names, or Set up when the registry does not hold it,
 * so no allowlist of rows can drift from the registry (ADR 0027).
 */
export const readStoredRow = (stored: unknown): SettingsRowId => (isSettingsRowId(stored) ? stored : FIRST_ROW);

/** The registry's entry for a row. */
export const settingsRow = (id: SettingsRowId): (typeof SETTINGS_ROWS)[number] => SETTINGS_ROWS.find((row) => row.id === id) as (typeof SETTINGS_ROWS)[number];

/**
 * The existing settings addresses: the sixteen the settings dialog answered
 * before the rail (fifteen panes and the legacy `cerebro`), a closed union
 * that stays so every deep link and stored section keeps landing (ADR 0027).
 */
export const SETTINGS_ADDRESSES = [
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
] as const;
export type SettingsAddress = (typeof SETTINGS_ADDRESSES)[number];

export const SettingsAddress = z.enum(SETTINGS_ADDRESSES).meta({
  description: "One of the sixteen existing settings addresses, each of which opens the row the address table maps it to.",
});

/**
 * The address table (ADR 0027; the GUI spec's table): the row each existing
 * address opens, total over the closed union, so an address added without a
 * row does not compile. Two addresses were split: `runs` opens Usage (spend,
 * hand-off) with its speed on `accounts.default-model`, and `advanced` opens
 * Your machines (updates, folders) with its service verbs on
 * `environments.service`; both are search terms of the second row too. The
 * state import (#94) maps a stored settings section through this table.
 */
export const ADDRESS_ROWS = {
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
} as const satisfies { readonly [A in SettingsAddress]: SettingsRowId };

/** Whether `value` is one of the sixteen existing settings addresses. */
export const isSettingsAddress = (value: unknown): value is SettingsAddress => (SETTINGS_ADDRESSES as readonly unknown[]).includes(value);

/** The row an existing settings address opens. */
export const rowOfAddress = (address: SettingsAddress): SettingsRowId => ADDRESS_ROWS[address];

export const SettingsAddressRow = z
  .object({ address: SettingsAddress, row: SettingsRowId })
  .meta({ description: "One line of the address table: an existing settings address and the row it opens." });
export type SettingsAddressRow = z.infer<typeof SettingsAddressRow>;
