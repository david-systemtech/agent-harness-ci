import { z } from "zod";
import { DefaultAccount, DefaultEffort, DefaultModelFamily, FavouriteModels } from "./accounts.js";
import { BROWSER_SETTINGS } from "./browser-settings.js";
import { CREDENTIAL_SETTINGS } from "./credential-settings.js";
import type { EventTypeEntry } from "./event-types.js";
import { ReviewSeenPayload } from "./permissions.js";
import { PERMISSION_SETTINGS } from "./permissions-settings.js";
import { PROCESS_IDLE_MINUTES_PRESET, ProcessIdleMinutes } from "./methods/providers.js";
import { NETWORK_SETTINGS } from "./network.js";
import { setOf } from "./primitives.js";
import type { SettingsRowId } from "./settings-rows.js";
import type { StepId } from "./steps.js";
import { DEFAULT_THEME, Theme } from "./theme.js";
import { UPDATE_SETTINGS } from "./update-settings.js";

/**
 * The environment's settings (session-state spec, "Commands" and "Auto-settle:
 * rules and settings"; ADR 0016): one table of keys, each with its schema,
 * its preset and the step of Set up that writes it. `settings.get` and
 * `settings.update` are the harness's generic key-value methods over this
 * table: later workstreams add keys here, never methods. A key a step does
 * not write fails the step registry's contract test (`steps.ts`).
 *
 * A setting is environment state, so a change to one is an event: one
 * `settings.updated` on the environment's `settings` stream, whose id is the
 * environment's id, naming the keys that changed with their new values.
 */

/** The stream kind of the environment's settings; the stream id is the environment's id. */
export const SETTINGS_STREAM_KIND = "settings";

/** The units an idle span is counted in: days, weeks, or calendar months. */
export const IDLE_SPAN_UNITS = ["days", "weeks", "months"] as const;
export const IdleSpanUnit = z.enum(IDLE_SPAN_UNITS).meta({
  description: "What an idle span is counted in: days, weeks (seven days) or months (calendar months, a month-end clamped to the shorter month's last day).",
});
export type IdleSpanUnit = z.infer<typeof IdleSpanUnit>;

/** The largest amount an idle span takes, in any unit: enough for any real span, and never past the calendar's end. */
export const MAX_IDLE_SPAN_AMOUNT = 1000;

/** A span of quiet: an amount of days, weeks or calendar months. */
export const IdleSpan = z
  .object({
    amount: z.int().min(1).max(MAX_IDLE_SPAN_AMOUNT),
    unit: IdleSpanUnit,
  })
  .meta({ description: `A span of quiet: 1 to ${MAX_IDLE_SPAN_AMOUNT} days, weeks or calendar months.` });
export type IdleSpan = z.infer<typeof IdleSpan>;

/** `sessions.autoSettleAfterIdle`: how long a session is quiet before auto-settle settles it, or null for never. */
export const AutoSettleAfterIdle = IdleSpan.nullable().meta({
  description: "How long a session is quiet before auto-settle settles it (settledBy auto-idle); null never settles a session for being idle.",
});

/** `sessions.autoSettleOnMerge`: whether a session one of whose pull requests merged is settled. */
export const AutoSettleOnMerge = z.boolean().meta({
  description: "Whether auto-settle settles a session one of whose pull requests merged at or after its anchor, the latest of its last activity, its unsettling and the end of its last snooze (settledBy auto-merge).",
});

/**
 * `instructions.orientation`: whether every run is handed the orientation
 * block first in its user layer (ADR 0011, ADR 0030). Off, the Orientation
 * row stays listed and the block is left out of the next run's text.
 */
export const OrientationOn = z.boolean().meta({
  description: "Whether every run is handed the orientation block, first in its standing instructions; off, the block is left out of the next run's text.",
});

/** The fewest and the most days `sessions.transcriptCompactAfterDays` takes. */
export const TRANSCRIPT_COMPACT_DAYS = { min: 1, max: 3650 } as const;

/**
 * `sessions.transcriptCompactAfterDays`: how many days a session is left
 * untouched before its transcript is compacted (env spec, "The event log":
 * compaction; ADR 0002). Never null: a pruning policy is owed, not optional.
 */
export const TranscriptCompactAfterDays = z
  .int()
  .min(TRANSCRIPT_COMPACT_DAYS.min)
  .max(TRANSCRIPT_COMPACT_DAYS.max)
  .meta({
    description: `How many whole days a session goes with no run, command or event before its transcript events are folded into a snapshot that replaces them for replay; ${TRANSCRIPT_COMPACT_DAYS.min} to ${TRANSCRIPT_COMPACT_DAYS.max}. Organisation events are never compacted.`,
  });

/**
 * Where a key sits: the step whose registry entry writes it, and the row of
 * Settings it shows on (ADR 0027), which is the step's home row or a row the
 * step links to (`settings-rows.test.ts`).
 */
export interface SettingPlace {
  readonly id: StepId;
  readonly row: SettingsRowId;
}

/** One key of the table: its schema, the value it holds until it is set, and the step that writes it with the row it sits on. */
export interface SettingDefinition<S extends z.ZodType = z.ZodType> {
  readonly schema: S;
  readonly preset: z.infer<S>;
  readonly step: SettingPlace;
  /**
   * The one method that writes the key, when a rule guards it (the
   * permission settings: `permissions.settings.set`, with the bypass
   * acknowledgement, #129; the update settings: `updates.settings.set`, which
   * checks a pin against the releases, #335): the generic `settings.update`
   * refuses it. Absent, `settings.update` writes it.
   */
  readonly writtenBy?: `${string}.${string}`;
}

/** A key's definition, its preset checked against its schema by the compiler. */
const setting = <const S extends z.ZodType>(definition: SettingDefinition<S>): SettingDefinition<S> => definition;

/**
 * Every settings key. The two auto-settle keys and the transcript compaction
 * window (#123) are the Your machines step's to write, moved from Appearance
 * as the session-state spec allowed (the Set up specification; #568), and
 * sit on `environments.service`: ADR 0027 closed the Appearance band at Theme
 * and Keyboard shortcuts, and they are the environment's policy on its log
 * (GUI spec). The Account step's own keys (ADR 0018: the default account, model
 * family and effort, #134; the favourite models, #1821) and `providers.processIdleMinutes` (#120) are the
 * Account step's, on `accounts.default-model` (which folds together what
 * were separate Models and Runs panes). The permission keys (#129) are the
 * Permissions step's, on `access.permissions`, written through
 * `permissions.settings.set` only, and the update keys (#335) the Your
 * machines step's, on `environments.machines`, written through
 * `updates.settings.set` only. The theme (ADR 0023: `appearance.theme`, a
 * name and seven seeds, preset "Default") is the Appearance step's, on its
 * home row, `appearance.theme`, written by `settings.update` (#391). The
 * browser keys (#541) are the Browser step's, on `access.browser`, written
 * through `settings.update`, and the injection keys (#367) the Key manager
 * step's, on `access.key-managers`, written the same way. The binding keys
 * (#574) are the Your machines step's, on `environments.machines`, written
 * through `settings.update` and applied at the environment's next start. The
 * orientation switch (`instructions.orientation`, preset on, #505) is the
 * Instructions step's, on `knowledge.instructions`, written by `settings.update`.
 */
const SESSIONS_PLACE = { id: "your-machines", row: "environments.service" } as const;
const DEFAULT_MODEL_PLACE = { id: "account", row: "accounts.default-model" } as const;

const SETTING_DEFINITIONS = {
  "sessions.autoSettleAfterIdle": setting({
    schema: AutoSettleAfterIdle,
    preset: { amount: 14, unit: "days" },
    step: SESSIONS_PLACE,
  }),
  "sessions.autoSettleOnMerge": setting({
    schema: AutoSettleOnMerge,
    preset: false,
    step: SESSIONS_PLACE,
  }),
  "sessions.transcriptCompactAfterDays": setting({
    schema: TranscriptCompactAfterDays,
    preset: 90,
    step: SESSIONS_PLACE,
  }),
  "accounts.defaultAccount": setting({
    schema: DefaultAccount,
    preset: null,
    step: DEFAULT_MODEL_PLACE,
  }),
  "accounts.defaultModelFamily": setting({
    schema: DefaultModelFamily,
    preset: null,
    step: DEFAULT_MODEL_PLACE,
  }),
  "accounts.defaultEffort": setting({
    schema: DefaultEffort,
    preset: null,
    step: DEFAULT_MODEL_PLACE,
  }),
  "accounts.favouriteModels": setting({
    schema: FavouriteModels,
    preset: [],
    step: DEFAULT_MODEL_PLACE,
  }),
  "providers.processIdleMinutes": setting({
    schema: ProcessIdleMinutes,
    preset: PROCESS_IDLE_MINUTES_PRESET,
    step: DEFAULT_MODEL_PLACE,
  }),
  ...PERMISSION_SETTINGS,
  ...UPDATE_SETTINGS,
  "appearance.theme": setting({
    schema: Theme,
    preset: DEFAULT_THEME,
    step: { id: "appearance", row: "appearance.theme" },
  }),
  ...BROWSER_SETTINGS,
  ...CREDENTIAL_SETTINGS,
  ...NETWORK_SETTINGS,
  "instructions.orientation": setting({
    schema: OrientationOn,
    preset: true,
    step: { id: "instructions", row: "knowledge.instructions" },
  }),
} as const;

/** The words shown by settings editors, kept separate from the wire schemas. */
interface SettingWords {
  readonly label: string;
  readonly description: string;
}

const SETTING_WORDS = {
  "sessions.autoSettleAfterIdle": {
    label: "Settle idle sessions",
    description: "Move quiet sessions out of the active list after this long. Choose none to keep them active until you settle them yourself.",
  },
  "sessions.autoSettleOnMerge": {
    label: "Settle sessions after merge",
    description: "Move a session out of the active list when one of its pull requests merges after its latest activity or return to the active list.",
  },
  "sessions.transcriptCompactAfterDays": {
    label: "Compact quiet transcripts after days",
    description: "After this many days without activity, keep a transcript summary in place of its detailed history. Session organisation is kept.",
  },
  "accounts.defaultAccount": {
    label: "Default account",
    description: "The account to use when a session has no account of its own. Choose none to use the first available account.",
  },
  "accounts.defaultModelFamily": {
    label: "Default model",
    description: "The model family to use when a run or session has no model of its own. Choose none to use the account's strongest model.",
  },
  "accounts.defaultEffort": {
    label: "Default thinking effort",
    description: "How much thinking to request when a run has no effort of its own. Choose none to use the model's default.",
  },
  "accounts.favouriteModels": {
    label: "Favourite models",
    description: "The models the account and model picker offers first, in this order. Every other model is under Other models; with none pinned, the picker offers the provider's recommended models.",
  },
  "providers.processIdleMinutes": {
    label: "Stop idle agent processes after minutes",
    description: "Keep an agent process ready between runs for this many minutes. A later run starts it again when needed.",
  },
  "permissions.defaultCeiling": {
    label: "Maximum permission mode",
    description: "The most permissive mode a session may use. A session can choose a stricter mode.",
  },
  "permissions.unattended.mode": {
    label: "Unattended permission mode",
    description: "The permission mode for scheduled or programmatic runs unless they choose their own. Bypassing permission checks requires your acknowledgement.",
  },
  "permissions.unattended.bypassAcknowledgedAt": {
    label: "Permission bypass acknowledged",
    description: "When you last accepted the warning about running unattended without permission checks. Recorded automatically when you accept it.",
  },
  "permissions.parkedPrompt.ttl": {
    label: "Unanswered permission timeout",
    description: "How long a permission question can wait before it is denied and the run continues. Choose never to wait until you answer; provider time limits may still apply.",
  },
  "permissions.containment.default": {
    label: "Default process containment",
    description: "How new sessions restrict agent processes and network access. The environment reports which restrictions this machine supports.",
  },
  "updates.autoUpdate": {
    label: "Automatic updates",
    description: "Update this environment to the newest release in its channel. Updates pause while a specific version is pinned.",
  },
  "updates.channel": {
    label: "Update channel",
    description: "Follow stable releases or include beta releases. A pinned version takes priority over the channel.",
  },
  "updates.pinnedVersion": {
    label: "Pinned version",
    description: "Keep this environment on a specific version. Choose none to return to the automatic update setting.",
  },
  "updates.idleWindowMinutes": {
    label: "Quiet time before updates in minutes",
    description: "Wait this many minutes without a run starting or ending before updating. A run waiting on a question counts as busy during this time.",
  },
  "updates.deferralCapHours": {
    label: "Maximum update delay in hours",
    description: "Let busy work delay a pending update for at most this many hours. After that, finish current work and update before accepting more.",
  },
  "appearance.theme": {
    label: "Theme",
    description: "The window's colour palette. Changes appear immediately on clients using this environment's theme.",
  },
  "browser.devSites": {
    label: "Development sites",
    description: "Sites where agents may run page scripts and read the full page. Each entry is an allowed origin or host pattern.",
  },
  "browser.evaluateEverywhere": {
    label: "Run scripts on any site",
    description: "Allow agents to run page scripts beyond your development sites, subject to browser permissions.",
  },
  "browser.deepReadEverywhere": {
    label: "Read full pages on any site",
    description: "Allow agents to read full page content beyond your development sites, subject to browser permissions.",
  },
  "browser.reach": {
    label: "Browser choice by account",
    description: "Choose whether each account's new sessions ask for a browser or always use a connected browser. Unlisted accounts choose per session.",
  },
  "browser.headless.allowRuns": {
    label: "Allow background browser use",
    description: "Allow agent runs to use the environment's browser without opening a visible window.",
  },
  "browser.headless.endpoint": {
    label: "Background browser address",
    description: "Connect to a browser you manage using its debugging address. Choose none to let the environment start its own browser.",
  },
  "browser.headless.executable": {
    label: "Background browser program",
    description: "The browser program to start on this machine. Choose none to use the browser found automatically.",
  },
  "browser.headless.limits": {
    label: "Background browser limits",
    description: "Limit simultaneous browser sessions, idle time and tab memory use. These limits always apply.",
  },
  "browser.internalHosts": {
    label: "Allowed internal hosts",
    description: "The internal host patterns agents may reach with the background browser or web reading. Other private addresses are blocked; cloud metadata addresses remain blocked.",
  },
  "credentials.injection": {
    label: "Provide credentials to agents",
    description: "Allow or deny access to forge and key-manager credentials during runs. Account and routine choices can override this setting.",
  },
  "credentials.injectionByAccount": {
    label: "Credential access by account",
    description: "Override credential access for each account's runs and terminals. Unlisted accounts use the environment's choice; a routine's own choice takes priority.",
  },
  "network.bindTailnet": {
    label: "Allow tailnet connections",
    description: "Accept paired clients on this machine's tailnet address from the environment's next start, when an address is available.",
  },
  "network.bindLan": {
    label: "Local network address",
    description: "Accept paired clients on this machine's chosen local network address from the next start. Choose none to keep local network access off.",
  },
  "instructions.orientation": {
    label: "Include orientation instructions",
    description: "Give agents the environment's introductory instructions at the start of every run. Turning this off leaves them out of future runs.",
  },
} satisfies Record<keyof typeof SETTING_DEFINITIONS, SettingWords>;

type LabeledSettings = { readonly [K in keyof typeof SETTING_DEFINITIONS]: (typeof SETTING_DEFINITIONS)[K] & SettingWords };

/** Every setting with its editor copy; schemas, presets and writing rules stay together. */
export const SETTINGS = Object.fromEntries(
  Object.entries(SETTING_DEFINITIONS).map(([key, definition]) => [key, { ...definition, ...SETTING_WORDS[key as keyof typeof SETTING_DEFINITIONS] }]),
) as LabeledSettings;

export type SettingsKey = keyof typeof SETTINGS;

/** Every settings key, in the table's order. */
export const SETTINGS_KEYS = Object.keys(SETTINGS) as [SettingsKey, ...SettingsKey[]];

/** The auto-settle keys: a change to either runs the sweep at once. */
export const AUTO_SETTLE_KEYS = ["sessions.autoSettleAfterIdle", "sessions.autoSettleOnMerge"] as const satisfies readonly SettingsKey[];

export const SettingsKeyName = z.enum(SETTINGS_KEYS).meta({ description: `A settings key: ${SETTINGS_KEYS.join(", ")}.` });

type SettingsShape = { readonly [K in SettingsKey]: (typeof SETTINGS)[K]["schema"] };
const settingsShape = Object.fromEntries(SETTINGS_KEYS.map((key) => [key, SETTINGS[key].schema])) as unknown as SettingsShape;

/** Every setting's value: what `settings.update` answers, a key never set holding its preset. */
export const SettingsValues = z.strictObject(settingsShape).meta({
  description: "Every setting's value, by key; a key never set holds its preset.",
});
export type SettingsValues = z.infer<typeof SettingsValues>;

/**
 * Some settings' values, by key, each checked against its key's schema; a
 * key the table does not have is refused. What `settings.update` takes,
 * `settings.get` answers for the keys asked, and `settings.updated` records.
 */
export const SettingsPatch = z.strictObject(settingsShape).partial().meta({
  description: "Some settings' values by key, each valid for its key; a key that is not a setting is refused.",
});
export type SettingsPatch = z.infer<typeof SettingsPatch>;

/** The keys the generic `settings.update` writes: every key no single method owns (`writtenBy`). */
export const GENERIC_SETTINGS_KEYS = SETTINGS_KEYS.filter((key) => (SETTINGS[key] as SettingDefinition).writtenBy === undefined);

/** Whether the generic `settings.update` may write `key`. */
export const isGenericSettingsKey = (key: string): boolean => (GENERIC_SETTINGS_KEYS as readonly string[]).includes(key);

/** Every key at its preset: the settings of an environment nobody has changed. */
export const presetSettings = (): SettingsValues =>
  SettingsValues.parse(Object.fromEntries(SETTINGS_KEYS.map((key) => [key, SETTINGS[key].preset])));

/**
 * How a generic settings editor edits a key (the tui spec's `/settings`,
 * #147; the GUI's generic rows the same): a `switch` for a boolean; a
 * `choice` among the values an enum (or a constant) takes, null among them
 * when the key takes none; `text` for anything else, typed as JSON (a bare
 * word as a string), `nullable` saying whether it takes null. Read from the
 * key's schema, so a key added to the table has its form at once.
 */
export type SettingForm =
  | { readonly kind: "switch" }
  | { readonly kind: "choice"; readonly options: readonly (string | number | boolean | null)[] }
  | { readonly kind: "text"; readonly nullable: boolean };

type Scalar = string | number | boolean | null;
interface JsonShape {
  readonly type?: string;
  readonly enum?: readonly Scalar[];
  readonly const?: Scalar;
  readonly anyOf?: readonly JsonShape[];
}

const formOf = (schema: z.ZodType): SettingForm => {
  const shape = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as JsonShape;
  const branches = shape.anyOf ?? [shape];
  const nullable = branches.some((branch) => branch.type === "null");
  const values = branches.filter((branch) => branch.type !== "null");
  const only = values.length === 1 ? values[0] : undefined;
  if (only?.type === "boolean") return nullable ? { kind: "choice", options: [true, false, null] } : { kind: "switch" };
  if (values.length > 0 && values.every((branch) => branch.enum !== undefined || branch.const !== undefined)) {
    const options = values.flatMap((branch): Scalar[] => (branch.enum !== undefined ? [...branch.enum] : [branch.const ?? null]));
    return { kind: "choice", options: nullable ? [...options, null] : options };
  }
  return { kind: "text", nullable };
};

const SETTING_FORMS = Object.fromEntries(SETTINGS_KEYS.map((key) => [key, formOf(SETTINGS[key].schema)])) as Readonly<Record<SettingsKey, SettingForm>>;

/** The form a generic editor edits `key` in. */
export const settingForm = (key: SettingsKey): SettingForm => SETTING_FORMS[key];

export const SettingsUpdatedPayload = z
  .object({ values: SettingsPatch.meta({ description: "The keys that changed, with their new values." }) })
  .meta({ description: "settings.updated: settings changed; the keys that did, with their new values." });
export type SettingsUpdatedPayload = z.infer<typeof SettingsUpdatedPayload>;

/**
 * `settings.changed`, the environment notice (GUI spec, "Live"; #391):
 * appended on the environment's own stream in the transaction of every
 * `settings.updated`, whichever method wrote it, naming the keys that
 * changed, so every connected client hears it whatever else it subscribes
 * to and fetches its settings again (a theme set from one client repaints
 * every window within a round trip). The values are not carried: a client
 * reads them through `settings.get` or the method of its own that answers
 * them, at the scope that method asks. The access log's `settings.changed`
 * (`permissions-settings.ts`) is another type of the same name on the
 * access stream.
 */
export const SettingsChangedNoticePayload = z
  .object({
    keys: setOf(SettingsKeyName)
      .min(1)
      .meta({ description: "The keys whose values changed, each once, in the order settings.updated names them." }),
  })
  .meta({ description: "settings.changed: settings changed on the environment; the keys that did, whose values a client reads again." });
export type SettingsChangedNoticePayload = z.infer<typeof SettingsChangedNoticePayload>;

/** The event types of the `settings` stream: none changes the session list. */
export const SETTINGS_EVENT_TYPES = {
  "settings.updated": { list: false, payload: SettingsUpdatedPayload },
  // The Unattended review's environment-wide watermark (#131): the environment's own state, moved by a person, beside its settings.
  "review.seen": { list: false, payload: ReviewSeenPayload },
} as const satisfies Record<string, EventTypeEntry>;

export type SettingsEventType = keyof typeof SETTINGS_EVENT_TYPES;
export const SettingsEventType = z
  .enum(Object.keys(SETTINGS_EVENT_TYPES) as [SettingsEventType, ...SettingsEventType[]])
  .meta({ description: "The event types of the settings stream: settings.updated, and review.seen, the Unattended review's watermark." });
