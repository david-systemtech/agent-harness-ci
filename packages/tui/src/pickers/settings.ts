import { BYPASS_ACKNOWLEDGED_KEY, SETTINGS, SETTINGS_KEYS, isGenericSettingsKey, settingForm, type SettingsKey } from "@agent-harness/contracts";

/**
 * `/settings`, the generic editor (docs/specs/tui.md, "Status, usage,
 * pickers"; the session-state spec's `settings.get` and `settings.update`):
 * every key of the contracts' settings table, its value drawn by the key's
 * form (`settingForm`: a switch, a choice, typed text) and written through
 * the method that writes the key. Pure: the words, the writer, and what a
 * typed value parses to.
 */

/** Every key, in the table's order: the editor's rows. */
export const EDITOR_KEYS: readonly SettingsKey[] = SETTINGS_KEYS;

/** A unit's name for `amount` of it: `1 day`, `14 days`. */
const unitWords = (amount: number, unit: string): string => `${amount} ${amount === 1 && unit.endsWith("s") ? unit.slice(0, -1) : unit}`;

/** A value in words: `on` or `off`, `none` for null, an amount of a unit as words, a number or a word as it is, anything else as JSON. */
export const valueWords = (value: unknown): string => {
  if (value === null || value === undefined) return "none";
  if (typeof value === "boolean") return value ? "on" : "off";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (typeof value === "object" && !Array.isArray(value)) {
    const { amount, unit, ...rest } = value as Record<string, unknown>;
    if (typeof amount === "number" && typeof unit === "string" && Object.keys(rest).length === 0) return unitWords(amount, unit);
  }
  return JSON.stringify(value);
};

/**
 * The method that writes `key`: the generic `settings.update`, or the one a
 * key's rule gives it (`writtenBy`, #117: the permission keys'
 * `permissions.settings.set`, with its bypass acknowledgement; the update
 * keys' `updates.settings.set`, #335); null for the one only the environment
 * records, the bypass acknowledgement's time.
 */
export type SettingsWriter = "settings.update" | "permissions.settings.set" | "updates.settings.set";

/** The methods of their own that write keys, of those `writtenBy` names. */
const OWN_WRITERS = ["permissions.settings.set", "updates.settings.set"] as const satisfies readonly SettingsWriter[];
const isOwnWriter = (method: string | undefined): method is (typeof OWN_WRITERS)[number] => (OWN_WRITERS as readonly (string | undefined)[]).includes(method);

export const writerOf = (key: SettingsKey): SettingsWriter | null => {
  if (key === BYPASS_ACKNOWLEDGED_KEY) return null;
  if (isGenericSettingsKey(key)) return "settings.update";
  const own = SETTINGS[key].writtenBy;
  return isOwnWriter(own) ? own : null;
};

/** What a key is for, in its schema's words. */
export const describeKey = (key: SettingsKey): string => SETTINGS[key].schema.description ?? "";

export type Parsed = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly line: string };

/**
 * A typed value as the key's: JSON first (`45`, `null`, `{"amount": 2,
 * "unit": "weeks"}`), else the words as a string, else an amount and a unit
 * (`2 weeks`, `1 day`), and `none` for null where the key takes it; the
 * first the key's schema accepts, or the schema's first objection to the
 * first reading.
 */
export const parseTyped = (key: SettingsKey, typed: string): Parsed => {
  const text = typed.trim();
  if (text === "") return { ok: false, line: `${key} takes a value; type one, or Esc to leave it.` };
  const schema = SETTINGS[key].schema;
  const form = settingForm(key);
  const readings: unknown[] = [];
  try {
    readings.push(JSON.parse(text));
  } catch {
    readings.push(text);
  }
  if (text.toLowerCase() === "none" && form.kind === "text" && form.nullable) readings.unshift(null);
  const span = /^(\d+)\s+([a-z]+)$/i.exec(text);
  if (span) {
    const unit = (span[2] as string).toLowerCase();
    readings.push({ amount: Number(span[1]), unit: unit.endsWith("s") ? unit : `${unit}s` });
  }
  for (const reading of readings) if (schema.safeParse(reading).success) return { ok: true, value: schema.parse(reading) };
  const issue = schema.safeParse(readings[0]).error?.issues[0];
  return { ok: false, line: `${key}: ${issue?.message ?? "not a value it takes"}` };
};
