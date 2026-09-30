import {
  FIRST_ROW,
  PRODUCT_NAME,
  SETTINGS,
  SETTINGS_KEYS,
  SETTINGS_ROWS,
  STEP_ORDER,
  STEP_REGISTRY,
  isSettingsAddress,
  isSettingsRowId,
  rowOfAddress,
  settingsRow,
  type SettingsRowId,
  type StepId,
} from "@agent-harness/contracts";

/**
 * Settings' rows as every renderer finds and opens them (docs/specs/gui.md,
 * "Settings: the rail, the rows and the addresses"; ADR 0027), over the
 * contracts' row registry and address table: the search the rail filters by,
 * the row an existing address or a row id names, the deep link that opens a
 * row, and the steps a row links to.
 */

/** What search reads of a row: its id, label, hint and search terms (its old addresses and section names), in lower case. */
const SEARCHED = new Map<SettingsRowId, string>(SETTINGS_ROWS.map((row) => [row.id, [row.id, row.label, row.hint, ...row.terms].join("\n").toLowerCase()]));

/**
 * The rows search finds for `query`, in the rail's order: those in whose id,
 * label, hint or old names every word typed is found, ignoring case, so
 * "secrets" finds Key managers and "cerebro" Memory banks; every row for an
 * empty query.
 */
export const matchSettingsRows = (query: string): readonly SettingsRowId[] => {
  const words = query.toLowerCase().split(/\s+/).filter((word) => word !== "");
  return SETTINGS_ROWS.map((row) => row.id).filter((id) => words.every((word) => (SEARCHED.get(id) ?? "").includes(word)));
};

/**
 * The row `name` opens: an existing settings address the row the address
 * table maps it to, or a row id that row, ignoring case and the space around
 * it; undefined for anything else.
 */
export const settingsRowNamed = (name: string): SettingsRowId | undefined => {
  const typed = name.trim().toLowerCase();
  if (isSettingsAddress(typed)) return rowOfAddress(typed);
  return isSettingsRowId(typed) ? typed : undefined;
};

/** The deep link that opens the row `name` (an address or a row id) in the desktop: `agent-harness://settings/<name>` (a chosen default). */
export const settingsDeepLink = (name: string): string => `${PRODUCT_NAME}://settings/${encodeURIComponent(name)}`;

const SETTINGS_LINK = new RegExp(`^${PRODUCT_NAME}://settings(?:/([^/?#\\s]*))?/?$`, "i");

/** What a settings deep link opens: a row, or null for the last row opened. */
export interface SettingsLink {
  readonly row: SettingsRowId | null;
}

/**
 * What a deep link the desktop was handed opens in Settings: the row the
 * address or row id after `agent-harness://settings/` names; the last row
 * opened for a bare `agent-harness://settings`; Set up for a name this build
 * does not hold, as for a stored row it does not (ADR 0027). Undefined for
 * any other link.
 */
export const parseSettingsLink = (url: string): SettingsLink | undefined => {
  const match = SETTINGS_LINK.exec(url.trim());
  if (!match) return undefined;
  const named = match[1] ?? "";
  if (named === "") return { row: null };
  let name: string;
  try {
    name = decodeURIComponent(named);
  } catch {
    return { row: FIRST_ROW };
  }
  return { row: settingsRowNamed(name) ?? FIRST_ROW };
};

/**
 * The steps of Set up a row links to, in the checklist's order after its own:
 * the steps it is home to, then the steps whose keys sit on it or that link
 * it as a further row (a step's `links`). None on Set up, which is home to
 * the whole checklist, and none on a row no step lives on.
 */
/** The row each step lives on, from the row registry: every step of the order has one, registered or not. */
const HOME_ROWS: ReadonlyMap<StepId, SettingsRowId> = new Map(
  SETTINGS_ROWS.flatMap((row) => (typeof row.homeOf === "string" ? [] : row.homeOf.map((step): [StepId, SettingsRowId] => [step, row.id]))),
);

/** The row a step lives on: where Set up's link to it, and a notice its step answers, open. */
export const stepHome = (step: StepId): SettingsRowId => HOME_ROWS.get(step) as SettingsRowId;

export const rowSteps = (id: SettingsRowId): readonly StepId[] => {
  const { homeOf } = settingsRow(id);
  if (!Array.isArray(homeOf)) return [];
  const home: readonly StepId[] = homeOf;
  const writing = new Set<StepId>(SETTINGS_KEYS.filter((key) => SETTINGS[key].step.row === id).map((key) => SETTINGS[key].step.id));
  for (const step of STEP_REGISTRY) if (step.links.some((link) => "row" in link && link.row === id)) writing.add(step.id);
  return [...home, ...STEP_ORDER.filter((step) => writing.has(step) && !home.includes(step))];
};
