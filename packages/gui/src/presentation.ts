import {
  SIDEBAR_VIEWS,
  writable,
  type CollapsedHeadings,
  type DocumentStore,
  type NewSessionChips,
  type NewSessionFocus,
  type Observable,
  type SidebarView,
} from "@agent-harness/client-runtime";
import { SessionBrowser, Theme, WorkspaceRequest } from "@agent-harness/contracts";
import { readRemaps, type KeyRemaps } from "./keys/key-map.js";

/**
 * The GUI's client-local presentation (ADR 0003, ADR 0004; glossary: Pane):
 * what is open, laid out, folded or preferred on this client, and never a
 * session's state. It is the one module where the organisation-state lint
 * allows its enumerated presentation keys
 * (`eslint-rules/no-client-organisation-state.ts`), and every key it holds
 * is on that list: a surface that keeps something here adds its key to
 * `PresentationValues`, `PRESENTATION_DEFAULTS`, `READERS` and the lint's
 * list together (docs/specs/gui.md, "How the renderer holds state").
 *
 * It is kept in the platform's documents (IndexedDB on the desktop) as one
 * document, written whole on each change, so what it holds survives the
 * window closing.
 */

/** A session as a pane shows it: the environment it is on, and its id there. */
export interface PaneSession {
  readonly environmentId: string;
  readonly sessionId: string;
}

/**
 * The new-session surface a pane holds until its first send (docs/specs/gui.md, "A new session"; #420): the id its
 * session is created under, minted as it opened; what its chips preset from, as the client runtime's
 * `projections.newSession` takes it; and the chips chosen on it since. What is typed on it is not kept here: it lasts
 * while the window does.
 */
export interface PaneNewSession {
  readonly id: string;
  readonly focus: NewSessionFocus;
  readonly chips: NewSessionChips;
}

/** One session pane of the grid: its id, which its divider's place is kept by, and the session it shows, null while it shows none. */
export interface GridPane {
  readonly id: string;
  readonly session: PaneSession | null;
  /** The new-session surface it holds while it shows no session; none while it shows a session or the word to choose one. */
  readonly newSession?: PaneNewSession;
  /** Its width, as a share of its row in percent. */
  readonly width: number;
}

/** A row of the grid: its id, its panes left to right, and its height as a share of the grid in percent. */
export interface GridRow {
  readonly id: string;
  readonly panes: readonly GridPane[];
  readonly height: number;
}

/**
 * The session pane region's layout (docs/specs/gui.md, "The seven panes and
 * the grid"; glossary: Pane): the grid's rows top to bottom, each of one or
 * more panes, eight panes at most, and the pane focused. A session shows in
 * one pane at a time. How it changes is `grid/layout.ts`'s.
 */
export interface PaneLayout {
  readonly rows: readonly GridRow[];
  /** The focused pane's id: one of the grid's. */
  readonly focused: string;
}

/** The most panes the grid holds (docs/specs/gui.md, "Chosen defaults": the existing limit). */
export const PANES_MOST = 8;

/** The grid before anything is split: one pane, with no session. */
const ONE_PANE: PaneLayout = Object.freeze({
  rows: Object.freeze([Object.freeze({ id: "row-1", height: 100, panes: Object.freeze([Object.freeze({ id: "pane-1", session: null, width: 100 })]) })]),
  focused: "pane-1",
});

/**
 * The panes a session pane's side column holds (docs/specs/gui.md, "The
 * seven panes and the grid"): this build's, in the spec's order; the
 * browser dock is beside Diff.
 */
export const SIDE_PANES = ["terminal", "files", "diff", "browser", "documents", "tasks", "preview"] as const;
export type SidePane = (typeof SIDE_PANES)[number];

/**
 * One session's side column: the panes open in it, in the strip's sequence,
 * the one it shows, and whether the column is hidden. A pane leaving the
 * screen stays open: hidden, never closed.
 */
export interface SideColumn {
  readonly open: readonly SidePane[];
  /** The pane shown, one of `open`; null only while none is open. */
  readonly shown: SidePane | null;
  /** The column is hidden: its panes stay open, and the one shown shows again with it. */
  readonly hidden: boolean;
}

/** The key a session's side column is kept under. */
export const sideColumnKey = (session: PaneSession): string => `${session.environmentId} ${session.sessionId}`;

/** How wide the transcript's column may grow: a comfortable measure, wider, or the whole pane. */
export const READING_WIDTHS = ["comfortable", "wide", "full"] as const;
export type ReadingWidth = (typeof READING_WIDTHS)[number];

/** The window's text size in CSS pixels: the least and the most it may be, so a stored value can never make the window unreadable. */
export const TEXT_SIZE_LEAST = 11;
export const TEXT_SIZE_MOST = 20;

/** look.md §3: every finite preference is a whole size inside the window's range. */
export const normalizeTextSize = (size: number): number => Number.isFinite(size) ? Math.min(TEXT_SIZE_MOST, Math.max(TEXT_SIZE_LEAST, Math.round(size))) : 14;

/**
 * Light or dark (ADR 0023): the ladder of the theme this client paints,
 * whatever the theme: the light one, the dark one, or the one the OS
 * prefers, followed as the OS switches.
 */
export const LIGHT_OR_DARK = ["system", "light", "dark"] as const;
export type LightOrDark = (typeof LIGHT_OR_DARK)[number];

/** Every key the presentation holds, and its value. */
export interface PresentationValues {
  /**
   * The sidebar region's integer width in pixels, as the
   * frame's divider last left it; null until it is first moved, when the
   * frame's preset width holds.
   */
  readonly sidebarWidth: number | null;
  /** Whether the sidebar is shown: `app.sidebar.toggle` (Mod+B) hides and shows it. */
  readonly sidebarShown: boolean;
  /** How the sidebar heads the active sessions: by merged group and environment, or by repository (the sidebar's switch). */
  readonly sidebarView: SidebarView;
  /**
   * Which of the sidebar's headings are folded, by heading name, keyed as
   * the terminal UI keys them (`block:pinned`, `group:<name key>`,
   * `repository:<identity>`, `shelf:snoozed`, `shelf:settled`,
   * `shelf:archive`): a merged heading or a repository spans environments,
   * so no one environment could own the flag. One not named takes its
   * default, the settled shelf and the archive folded.
   */
  readonly collapsedHeadings: CollapsedHeadings;
  readonly paneLayout: PaneLayout;
  /** Opaque native browser profile keys per grid pane and session; no page contents are stored here. */
  readonly browserPartitions: Readonly<Record<string, string>>;
  /** Each session's side column, by `sideColumnKey`; a session with no pane open has none. */
  readonly sideColumns: Readonly<Record<string, SideColumn>>;
  /** The window's text size, in CSS pixels (`TEXT_SIZE_LEAST` to `TEXT_SIZE_MOST`). */
  readonly textSize: number;
  /** How wide the transcript's column may grow. */
  readonly readingWidth: ReadingWidth;
  /** Whether a run's reasoning is unfolded when it is drawn. */
  readonly reasoningShown: boolean;
  /** Whether text still streaming fades in word by word. */
  readonly streamingFade: boolean;
  /**
   * Whether to run an environment on this machine (docs/specs/gui.md, "The
   * local environment, pairing and updates"): on, the window installs and
   * starts this machine's environment on first launch; off, it opens on
   * pairing with an environment elsewhere.
   */
  readonly runLocalEnvironment: boolean;
  /** Light or dark: this client's own preference, never the theme's (docs/specs/gui.md, "Theme: tokens, the setting and the lint"). */
  readonly lightOrDark: LightOrDark;
  /**
   * The home environment's theme as this window last read it, painted on
   * the next launch's first frame before anything is connected; null until
   * one was read, when the preset is painted.
   */
  readonly cachedTheme: Theme | null;
  /**
   * The row of Settings last opened, by its id (docs/specs/gui.md,
   * "Settings: the rail, the rows and the addresses"): kept as the id and
   * read against the row registry when Settings opens, so an id the registry
   * no longer holds opens Set up (ADR 0027); null until a row is opened.
   */
  readonly settingsRow: string | null;
  /**
   * The first-launch mark (docs/specs/gui.md, "Set up in the window"): set
   * once Set up, the whole window on first launch, is finished or closed.
   * While it is unset, each launch opens Set up as the whole window once the
   * home environment is ready; one left for a row of Settings stays shut
   * for the rest of that launch (`setup/checklist-window.tsx`).
   */
  readonly firstLaunchDone: boolean;
  /** Dismissed access disclosures, keyed by environment and pairing identity. */
  readonly dismissedPairingAccess: Readonly<Record<string, string>>;
  /**
   * This client's GUI key remaps (docs/specs/gui.md, "Keyboard: the GUI
   * column and the Keyboard shortcuts pane"; ADR 0022): an action's keys by
   * its id, read against the defaults (`keys/key-map.ts`), so a remap of an
   * id the list no longer has is dropped; the terminal UI keeps its own in
   * its keybindings file.
   */
  readonly keyRemaps: KeyRemaps;
  /** "Esc stops the run": the switch that heads the Keyboard shortcuts pane, off by default, binding app.interrupt's Esc (ADR 0022). */
  readonly escStopsRun: boolean;
}

export type PresentationKey = keyof PresentationValues;

/** What each key holds before anything is set. */
export const PRESENTATION_DEFAULTS: PresentationValues = Object.freeze({
  sidebarWidth: null,
  sidebarShown: true,
  sidebarView: "groups",
  collapsedHeadings: Object.freeze({}),
  paneLayout: ONE_PANE,
  sideColumns: Object.freeze({}),
  browserPartitions: Object.freeze({}),
  textSize: 14,
  readingWidth: "comfortable",
  reasoningShown: true,
  streamingFade: true,
  runLocalEnvironment: true,
  lightOrDark: "system",
  cachedTheme: null,
  settingsRow: null,
  firstLaunchDone: false,
  dismissedPairingAccess: Object.freeze({}),
  keyRemaps: Object.freeze({}),
  escStopsRun: false,
});

/** The document the presentation is kept in, and the format this build writes. */
const DOCUMENT = "presentation";
const FORMAT = 1;

/** A side column as stored, without the panes this build cannot show (a newer build's); undefined when none it can show is open. */
const readSideColumn = (stored: unknown): SideColumn | undefined => {
  if (typeof stored !== "object" || stored === null) return undefined;
  const { open, shown, hidden } = stored as { readonly open?: unknown; readonly shown?: unknown; readonly hidden?: unknown };
  const kept = Array.isArray(open) ? SIDE_PANES.filter((pane) => open.includes(pane)).sort((a, b) => open.indexOf(a) - open.indexOf(b)) : [];
  const first = kept[0];
  if (first === undefined) return undefined;
  return { open: kept, shown: kept.find((pane) => pane === shown) ?? first, hidden: hidden === true };
};

/** A share in percent as stored: a number above none and up to the whole. */
const isShare = (stored: unknown): stored is number => typeof stored === "number" && stored > 0 && stored <= 100;

/** Shares scaled to fill the whole, 100 percent, each kept in proportion. */
const toWhole = (shares: readonly number[]): readonly number[] => {
  const sum = shares.reduce((total, share) => total + share, 0);
  return shares.map((share) => (share * 100) / sum);
};

/** A pane's session as stored: its two ids, or null for none; undefined when it is neither. */
const readPaneSession = (stored: unknown): PaneSession | null | undefined => {
  if (stored === null) return null;
  const ids = stored as { readonly environmentId?: unknown; readonly sessionId?: unknown } | undefined;
  return typeof ids?.environmentId === "string" && typeof ids.sessionId === "string" ? { environmentId: ids.environmentId, sessionId: ids.sessionId } : undefined;
};

/** A stored object's field that is a string; undefined when it is not. */
const stringIn = (stored: unknown, field: string): string | undefined => {
  const value = typeof stored === "object" && stored !== null ? (stored as Record<string, unknown>)[field] : undefined;
  return typeof value === "string" ? value : undefined;
};

/** A new-session surface's focus as stored: nothing, an environment, or a session on one; undefined for anything else. */
const readFocus = (stored: unknown): NewSessionFocus | undefined => {
  const environmentId = stringIn(stored, "environmentId");
  const sessionId = stringIn(stored, "sessionId");
  switch (stringIn(stored, "kind")) {
    case "none":
      return { kind: "none" };
    case "environment":
      return environmentId === undefined ? undefined : { kind: "environment", environmentId };
    case "session":
      return environmentId === undefined || sessionId === undefined ? undefined : { kind: "session", environmentId, sessionId };
    default:
      return undefined;
  }
};

/** A new-session surface's chips as stored, each one this build cannot read left unset. */
const readChips = (stored: unknown): NewSessionChips => {
  const held = typeof stored === "object" && stored !== null ? (stored as Record<string, unknown>) : {};
  const environmentId = stringIn(held, "environmentId");
  const model = stringIn(held, "model");
  const effort = held["effort"] === null ? null : stringIn(held, "effort");
  const account = { environmentId: stringIn(held["account"], "environmentId"), accountId: stringIn(held["account"], "accountId") };
  const workspaceOn = stringIn(held["workspace"], "environmentId");
  const browser = held["browser"] === null ? null : SessionBrowser.safeParse(held["browser"]).data;
  const request = WorkspaceRequest.safeParse((held["workspace"] as Record<string, unknown> | undefined)?.["request"]).data;
  return {
    ...(environmentId !== undefined && { environmentId }),
    ...(account.environmentId !== undefined && account.accountId !== undefined && { account: { environmentId: account.environmentId, accountId: account.accountId } }),
    ...(model !== undefined && { model }),
    ...(effort !== undefined && { effort }),
    ...(browser !== undefined && { browser }),
    ...(workspaceOn !== undefined && request !== undefined && { workspace: { environmentId: workspaceOn, request } }),
  };
};

/** A new-session surface as stored: its id and a focus this build reads, with its chips; undefined for anything else. */
const readNewSession = (stored: unknown): PaneNewSession | undefined => {
  const id = stringIn(stored, "id");
  const focus = readFocus((stored as Record<string, unknown> | undefined)?.["focus"]);
  return id === undefined || focus === undefined ? undefined : { id, focus, chips: readChips((stored as Record<string, unknown>)["chips"]) };
};

/** A pane or a row as stored: an object with a string id and a share. */
const readPart = (
  stored: unknown,
  share: "width" | "height",
): { readonly id: string; readonly share: number; readonly held: Record<string, unknown> } | undefined => {
  if (typeof stored !== "object" || stored === null) return undefined;
  const held = stored as Record<string, unknown>;
  return typeof held["id"] === "string" && isShare(held[share]) ? { id: held["id"], share: held[share], held } : undefined;
};

/**
 * The grid as stored: rows of panes, one to eight panes in all, every id
 * once, each share a number, scaled so a row's widths and the rows' heights
 * each fill the whole. A session shown twice is kept in its first pane
 * only; a focused pane the grid does not hold is its first. A pane showing
 * no session keeps its new-session surface when it can be read, and shows
 * none otherwise. Undefined for anything else.
 */
const readPaneLayout = (stored: unknown): PaneLayout | undefined => {
  if (typeof stored !== "object" || stored === null) return undefined;
  const { rows: storedRows, focused } = stored as { readonly rows?: unknown; readonly focused?: unknown };
  if (!Array.isArray(storedRows) || storedRows.length === 0) return undefined;
  const ids = new Set<string>();
  const shown = new Set<string>();
  const rows: { id: string; height: number; panes: GridPane[] }[] = [];
  for (const storedRow of storedRows) {
    const row = readPart(storedRow, "height");
    const storedPanes = row?.held["panes"];
    if (row === undefined || ids.has(row.id) || !Array.isArray(storedPanes) || storedPanes.length === 0) return undefined;
    ids.add(row.id);
    const panes: GridPane[] = [];
    for (const storedPane of storedPanes) {
      const pane = readPart(storedPane, "width");
      const session = readPaneSession(pane?.held["session"]);
      if (pane === undefined || ids.has(pane.id) || session === undefined) return undefined;
      ids.add(pane.id);
      const key = session === null ? null : sideColumnKey(session);
      const newSession = session === null ? readNewSession(pane.held["newSession"]) : undefined;
      panes.push({ id: pane.id, session: key === null || shown.has(key) ? null : session, width: pane.share, ...(newSession !== undefined && { newSession }) });
      if (key !== null) shown.add(key);
    }
    const widths = toWhole(panes.map((pane) => pane.width));
    rows.push({ id: row.id, height: row.share, panes: panes.map((pane, at) => ({ ...pane, width: widths[at] ?? pane.width })) });
  }
  const panes = rows.flatMap((row) => row.panes);
  if (panes.length > PANES_MOST) return undefined;
  const heights = toWhole(rows.map((row) => row.height));
  return {
    rows: rows.map((row, at) => ({ ...row, height: heights[at] ?? row.height })),
    focused: panes.find((pane) => pane.id === focused)?.id ?? (panes[0] as GridPane).id,
  };
};

/** How each key's stored value is read back: undefined for a value this build cannot read, which takes the default. */
const READERS: { readonly [K in PresentationKey]: (stored: unknown) => PresentationValues[K] | undefined } = {
  sidebarWidth: (stored) => stored === null ? null : typeof stored === "number" && Number.isFinite(stored) ? Math.round(Math.max(200, Math.min(460, stored))) : undefined,
  sidebarShown: (stored) => (typeof stored === "boolean" ? stored : undefined),
  sidebarView: (stored) => SIDEBAR_VIEWS.find((view) => view === stored),
  collapsedHeadings: (stored) => {
    if (typeof stored !== "object" || stored === null || Array.isArray(stored)) return undefined;
    const folds = Object.entries(stored);
    return folds.every(([, shut]) => typeof shut === "boolean") ? (Object.fromEntries(folds) as CollapsedHeadings) : undefined;
  },
  paneLayout: (stored) => readPaneLayout(stored),
  browserPartitions: (stored) => {
    if (typeof stored !== "object" || stored === null || Array.isArray(stored)) return undefined;
    return Object.fromEntries(
      Object.entries(stored).filter((entry): entry is [string, string] => typeof entry[1] === "string" && /^[a-z0-9-]{1,100}$/.test(entry[1])),
    );
  },
  sideColumns: (stored) => {
    if (typeof stored !== "object" || stored === null || Array.isArray(stored)) return undefined;
    const columns: Record<string, SideColumn> = {};
    for (const [key, value] of Object.entries(stored)) {
      const column = readSideColumn(value);
      if (column !== undefined) columns[key] = column;
    }
    return columns;
  },
  textSize: (stored) => (typeof stored === "number" ? normalizeTextSize(stored) : undefined),
  readingWidth: (stored) => READING_WIDTHS.find((width) => width === stored),
  reasoningShown: (stored) => (typeof stored === "boolean" ? stored : undefined),
  streamingFade: (stored) => (typeof stored === "boolean" ? stored : undefined),
  runLocalEnvironment: (stored) => (typeof stored === "boolean" ? stored : undefined),
  lightOrDark: (stored) => LIGHT_OR_DARK.find((preference) => preference === stored),
  cachedTheme: (stored) => (stored === null ? null : Theme.safeParse(stored).data),
  settingsRow: (stored) => (stored === null || typeof stored === "string" ? stored : undefined),
  dismissedPairingAccess: (stored) => typeof stored === "object" && stored !== null && !Array.isArray(stored) && Object.values(stored).every(value => typeof value === "string") ? stored as Readonly<Record<string, string>> : undefined,
  firstLaunchDone: (stored) => (typeof stored === "boolean" ? stored : undefined),
  keyRemaps: (stored) => readRemaps(stored),
  escStopsRun: (stored) => (typeof stored === "boolean" ? stored : undefined),
};

export interface Presentation {
  /** Everything held, one value per key; `read()` keeps its reference until a value changes. */
  readonly values: Observable<PresentationValues>;
  /** Holds `value` under `key` and writes the document; a value already held changes nothing. */
  set<K extends PresentationKey>(key: K, value: PresentationValues[K]): void;
  /** Settles once every write started so far has. */
  close(): Promise<void>;
}

/** The values a stored document holds, each unreadable one at its default; the keys that could not be read, named. */
const readDocument = (stored: unknown): { readonly values: PresentationValues; readonly unreadable: readonly string[] } => {
  if (stored === undefined) return { values: PRESENTATION_DEFAULTS, unreadable: [] };
  if (typeof stored !== "object" || stored === null || (stored as { readonly format?: unknown }).format !== FORMAT)
    return { values: PRESENTATION_DEFAULTS, unreadable: ["the document"] };
  const unreadable: string[] = [];
  const values = { ...PRESENTATION_DEFAULTS } as Record<PresentationKey, unknown>;
  for (const key of Object.keys(READERS) as PresentationKey[]) {
    if (!(key in stored)) continue;
    const value = READERS[key]((stored as Record<string, unknown>)[key]);
    if (value === undefined) unreadable.push(key);
    else values[key] = value;
  }
  return { values: values as unknown as PresentationValues, unreadable };
};

/**
 * The presentation kept in `documents`: read once now, written whole on each
 * change, the writes one after another. What cannot be read is reported
 * once through `report` and starts from its default; a write that fails is
 * reported, and the value stays held for this window.
 */
export const openPresentation = async (documents: DocumentStore, report: (error: unknown) => void = () => undefined): Promise<Presentation> => {
  let stored: unknown;
  try {
    stored = await documents.get(DOCUMENT);
  } catch (error) {
    report(error);
  }
  const { values: initial, unreadable } = readDocument(stored);
  if (unreadable.length > 0) report(new Error(`The presentation document could not be read in full (${unreadable.join(", ")}); what it could not read starts from its default.`));

  const values = writable<PresentationValues>(initial);
  let writes: Promise<void> = Promise.resolve();
  return {
    values,
    set(key, value) {
      const now = values.read();
      const normalized = key === "textSize" ? READERS.textSize(value) ?? 14 : value;
      if (Object.is(now[key], normalized)) return;
      const next: PresentationValues = { ...now, [key]: normalized };
      values.set(next);
      writes = writes.then(() => documents.set(DOCUMENT, { format: FORMAT, ...next })).catch(report);
    },
    close: () => writes,
  };
};
