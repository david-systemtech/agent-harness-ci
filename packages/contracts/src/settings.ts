import { z } from "zod";
import type { EventTypeEntry } from "./event-types.js";
import { ReviewSeenPayload } from "./permissions.js";
import { PERMISSION_SETTINGS } from "./permissions-settings.js";
import { PROCESS_IDLE_MINUTES_PRESET, ProcessIdleMinutes } from "./methods/providers.js";

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

/** Where a key sits in Set up: the step whose registry entry writes it, and the band of that step's settings pane it shows in. */
export interface SettingPlace {
  readonly id: string;
  readonly band: string;
}

/** One key of the table: its schema, the value it holds until it is set, and the step that writes it. */
export interface SettingDefinition<S extends z.ZodType = z.ZodType> {
  readonly schema: S;
  readonly preset: z.infer<S>;
  readonly step: SettingPlace;
  /**
   * The one method that writes the key, when a rule guards it (the
   * permission settings: `permissions.settings.set`, with the bypass
   * acknowledgement, #129): the generic `settings.update` refuses it. Absent,
   * `settings.update` writes it.
   */
  readonly writtenBy?: `${string}.${string}`;
}

/** A key's definition, its preset checked against its schema by the compiler. */
const setting = <const S extends z.ZodType>(definition: SettingDefinition<S>): SettingDefinition<S> => definition;

/**
 * Every settings key. The two auto-settle keys sit under the Appearance
 * step's entry, in a Sessions band of its pane (session-state spec), and the
 * transcript compaction window (#123) beside them; the Set up workstream
 * (#88) may re-home them. `providers.processIdleMinutes`
 * (#120) sits under the Account step's entry, in the Default model band of
 * the Accounts pane (ADR 0027's `accounts.default-model` row, which absorbs
 * Artemis's Runs pane); the Account step's own keys (#134) join it there.
 * The permission keys (#129) are the Permissions step's, written through
 * `permissions.settings.set` only.
 */
export const SETTINGS = {
  "sessions.autoSettleAfterIdle": setting({
    schema: AutoSettleAfterIdle,
    preset: { amount: 14, unit: "days" },
    step: { id: "appearance", band: "sessions" },
  }),
  "sessions.autoSettleOnMerge": setting({
    schema: AutoSettleOnMerge,
    preset: false,
    step: { id: "appearance", band: "sessions" },
  }),
  "sessions.transcriptCompactAfterDays": setting({
    schema: TranscriptCompactAfterDays,
    preset: 90,
    step: { id: "appearance", band: "sessions" },
  }),
  "providers.processIdleMinutes": setting({
    schema: ProcessIdleMinutes,
    preset: PROCESS_IDLE_MINUTES_PRESET,
    step: { id: "account", band: "default-model" },
  }),
  ...PERMISSION_SETTINGS,
} as const;

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

export const SettingsUpdatedPayload = z
  .object({ values: SettingsPatch.meta({ description: "The keys that changed, with their new values." }) })
  .meta({ description: "settings.updated: settings changed; the keys that did, with their new values." });
export type SettingsUpdatedPayload = z.infer<typeof SettingsUpdatedPayload>;

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
