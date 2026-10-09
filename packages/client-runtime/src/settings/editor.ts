import {
  BYPASS_ACKNOWLEDGED_KEY,
  SETTINGS,
  SETTINGS_KEYS,
  STEP_REGISTRY,
  isGenericSettingsKey,
  settingForm,
  settingsRow,
  type Confirmation,
  type ParamsOf,
  type SettingsKey,
  type SettingsRowId,
} from "@agent-harness/contracts";
import type { Runtime } from "../runtime.js";
import { adminCall, type AdminOutcome } from "../status/actions.js";
import type { RefusedAnswer } from "../words/refusal.js";

/**
 * The generic settings editor both renderers draw (docs/specs/tui.md,
 * "Status, usage, pickers": `/settings`; docs/specs/gui.md, "Settings: the
 * rail, the rows and the addresses": a row whose feature is not built): the
 * keys of the contracts' settings table that sit on a row (ADR 0027), each
 * value in words, drawn by the key's form (`settingForm`: a switch, a
 * choice, typed text), what a typed value parses to, and the key written
 * through the method that writes it (`settings.update`, or the one its rule
 * gives it), so the terminal and the window edit a key alike (ADR 0004).
 */

/** The keys that sit on the row, in the table's order. */
export const rowKeys = (row: SettingsRowId): readonly SettingsKey[] => SETTINGS_KEYS.filter((key) => SETTINGS[key].step.row === row);

/** What an editor says when the row asked for holds no key. */
export const noKeysLine = (row: SettingsRowId): string => `${settingsRow(row).label} holds no settings key.`;

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

/** What a setting is for, in the words shown by both editors. */
export const describeKey = (key: SettingsKey): string => SETTINGS[key].description;

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

/** The confirmations the registered steps' forms ask before writing a value. */
const CONFIRMATIONS: readonly Confirmation[] = STEP_REGISTRY.flatMap((step): readonly Confirmation[] => ("confirms" in step ? step.confirms : []));

/**
 * What an editor confirms before writing `value` to `key`: the step
 * registry's confirmation for that value (ADR 0006: choosing bypass shows
 * one sentence), whose acknowledgement goes with the write; undefined when
 * the value is written unasked.
 */
export const confirmationOf = (key: SettingsKey, value: unknown): Confirmation | undefined =>
  CONFIRMATIONS.find((confirmation) => confirmation.key === key && confirmation.value === value);

/** How a write went: the values the environment answered with (the key's among them), or the one line that says why not, with the environment's refusal when it refused. */
export type SettingSaved = { readonly ok: true; readonly values: Readonly<Record<string, unknown>> } | { readonly ok: false; readonly line: string; readonly refusal?: RefusedAnswer };

export interface SaveOptions {
  /** The command's id: an `admin` command sent directly, never queued, answered from its stored receipt when sent again. */
  readonly commandId: string;
  /** The bypass sentence was shown and accepted (ADR 0006): sent with the unattended mode's bypassPermissions. */
  readonly acknowledgeBypass?: boolean;
}

/** A write's outcome: the values the environment answered with, or, from a retry answered by its stored receipt, the value sent. */
const savedFrom = (answer: AdminOutcome<SettingsWriter>, written: Readonly<Record<string, unknown>>): SettingSaved =>
  answer.ok ? { ok: true, values: answer.result?.values ?? written } : { ok: false, line: answer.line, refusal: answer.refusal };

/**
 * Writes `value` to `key` on the environment through the method that writes
 * the key (`writerOf`), as a direct `admin` request: `settings.update`,
 * `permissions.settings.set` (with `acknowledgeBypass` when asked) or
 * `updates.settings.set`. The value should be one the key's schema takes
 * (`parseTyped`, a form's options); the request checks it against the
 * method's params again. A key nothing writes is refused without a request.
 */
export const saveSetting = async (runtime: Pick<Runtime, "requests">, environmentId: string, key: SettingsKey, value: unknown, options: SaveOptions): Promise<SettingSaved> => {
  const writer = writerOf(key);
  if (writer === null) return { ok: false, line: `${key} is recorded by the environment itself; nothing sets it.` };
  const values = { [key]: value };
  const { commandId } = options;
  switch (writer) {
    case "settings.update":
      return savedFrom(await adminCall(() => runtime.requests.call(environmentId, writer, { commandId, values: values as ParamsOf<typeof writer>["values"] })), values);
    case "updates.settings.set":
      return savedFrom(await adminCall(() => runtime.requests.call(environmentId, writer, { commandId, values: values as ParamsOf<typeof writer>["values"] })), values);
    case "permissions.settings.set":
      return savedFrom(
        await adminCall(() =>
          runtime.requests.call(environmentId, writer, {
            commandId,
            values: values as ParamsOf<typeof writer>["values"],
            ...(options.acknowledgeBypass === true && { acknowledgeBypass: true as const }),
          }),
        ),
        values,
      );
  }
};
