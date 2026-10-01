import { PRODUCT_NAME, type PairedChrome, type SessionBrowser } from "@agent-harness/contracts";
import type { CapabilityAnswer } from "../capabilities.js";
import { LOCAL_PLACEHOLDER_ID, type ConnectionRecord } from "../connections/records.js";
import { dynamic, type Observable } from "../observable.js";
import type { CachedAnswer } from "../requests.js";
import type { SessionListView } from "./session-list.js";

/**
 * `projections.browsers(environmentId, sessionId)` (browser spec, "The
 * browser as a session field"; ADR 0014, ADR 0024; #561): the browser
 * picker both renderers draw, whose rows are what `sessions.setBrowser`
 * can set the session's browser to. A pure projection (ADR 0003) of
 * `browser.chromes.list` of the client's local environment and of the
 * session's, `browser.status` of the session's, all from the request cache
 * (fetched while followed, and again on `chrome.updated`, the status on
 * `settings.changed` too), the shell's `webView` and the session's field in
 * its list row.
 *
 * The rows, in the picker's order: the default, saying what a null field
 * resolves to for a run of the session now; for the local environment and
 * then the session's, the plain My Chrome when more than one Chrome is
 * paired with it, then each of its Chromes, connected or dimmed with the
 * reason (a Chrome of any other environment is not listed, since only
 * those two drive one for the session); the session environment's
 * headless browser with its availability; and the browser dock where the
 * shell has `webView`. The labels and notes are the picker copy ADR 0024
 * names, with the product name as the placeholder. A stored Chrome choice
 * outside the paired list is retained as a dim row with its reason.
 */

/** Why a row is dimmed: a Chrome is disconnected, unreachable or cannot be driven here; headless runs are disallowed, unavailable or not yet known. */
export type BrowserUnavailableReason = "disconnected" | "headless-not-allowed" | "headless-unavailable" | "unknown" | "unreachable" | "not-drivable";

export interface BrowserUnavailable {
  readonly reason: BrowserUnavailableReason;
  /** One line for people, saying what to do about it where something can be. */
  readonly message: string;
}

/** One row of the browser picker. */
export interface BrowserRow {
  /** What choosing it sets the session's browser to; null for the default, none chosen, which each run resolves. */
  readonly value: SessionBrowser | null;
  readonly label: string;
  /** What choosing it does. */
  readonly note: string;
  /** Why it cannot be used now, for a row drawn dimmed; null when it can. */
  readonly unavailable: BrowserUnavailable | null;
  /** The session's browser now: the row a picker marks. */
  readonly selected: boolean;
}

export interface PairedChromeGroup {
  readonly environmentId: string;
  readonly name: string;
  readonly chromes: readonly PairedChrome[];
  readonly stale: boolean;
  readonly error: string | null;
}

export interface BrowsersView {
  readonly environmentId: string;
  readonly sessionId: string;
  /** The rows, in the picker's order. */
  readonly rows: readonly BrowserRow[];
  /** Paired Chromes, including last-seen times and whether their cached list is stale. */
  readonly chromes: readonly PairedChromeGroup[];
  /** The session environment's headless state and listener details, held by the request cache. */
  readonly status: CachedAnswer<"browser.status">;
  /** The browser dock: present where the shell has `webView`, its row listed; else absent with `no-shell` and its line, and not listed. */
  readonly dock: CapabilityAnswer;
}

/** What the picker's rows read. */
export interface BrowserSources {
  /** The connection list: which environment is this client's local one, and each environment's name. */
  readonly records: Observable<readonly ConnectionRecord[]>;
  /** The request cache's `browser.chromes.list` of the environment: the same observable for each. */
  chromes(environmentId: string): Observable<CachedAnswer<"browser.chromes.list">>;
  /** The request cache's `browser.status` of the environment: the same observable for each. */
  status(environmentId: string): Observable<CachedAnswer<"browser.status">>;
  /** Whether the shell can embed a browser (`shell.webView`), which the browser dock is. */
  readonly webView: CapabilityAnswer;
}

export interface BrowsersHost extends BrowserSources {
  /** The session lists, whose row of the session holds its browser. */
  readonly sessionList: Observable<SessionListView>;
}

/** The client's local environment, once it has answered under its own id; null for a client with none. */
export const localEnvironmentOf = (records: readonly ConnectionRecord[]): string | null =>
  records.find((record) => record.kind === "local" && record.environmentId !== LOCAL_PLACEHOLDER_ID)?.environmentId ?? null;

/** The environments whose Chromes the picker lists: the local one, then the session's. */
const chromeEnvironments = (records: readonly ConnectionRecord[], environmentId: string): string[] => {
  const local = localEnvironmentOf(records);
  return local === null || local === environmentId ? [environmentId] : [local, environmentId];
};

/** Management rows read the same cached lists as the picker, retaining offline answers. */
const pairedChromes = (sources: BrowserSources, environmentId: string): PairedChromeGroup[] =>
  chromeEnvironments(sources.records.read(), environmentId).map((id) => {
    const record = sources.records.read().find((record) => record.environmentId === id);
    const answer = sources.chromes(id).read();
    return { environmentId: id, name: record?.descriptor.name ?? id, chromes: answer.result?.chromes ?? [], stale: record?.phase !== "ready" || answer.error !== null, error: answer.error?.message ?? null };
  });

/** What the rows for a session on `environmentId` follow. */
export const browserInputs = (sources: BrowserSources, environmentId: string): Observable<unknown>[] => [
  sources.records,
  ...chromeEnvironments(sources.records.read(), environmentId).map((id) => sources.chromes(id)),
  sources.status(environmentId),
];

const MY_CHROME = "My Chrome";
const NAMED_NOTE = "Always this browser, whatever else is open.";
const PLAIN_LABEL = `${MY_CHROME} (${PRODUCT_NAME} extension)`;
/** The plain My Chrome's note: listed only where several are paired, it says it takes whichever is open. */
const PLAIN_NOTE = "Your real Chrome, with your logins. The agent works in a tab group it keeps to itself, and some sites are refused. Whichever of them is open.";

const HEADLESS_LABEL = "Headless browser";

/** A row before the session's browser marks one. */
type Unmarked = Omit<BrowserRow, "selected">;

/** Why runs of a session on the environment named `name` cannot have its headless browser, from its `browser.status`; null when they can. */
const headlessUnavailable = (status: CachedAnswer<"browser.status">, name: string): BrowserUnavailable | null => {
  const headless = status.result?.headless;
  if (headless === undefined) {
    const message = status.error === null ? `${name} has not said whether it has a headless browser.` : `${name} could not say whether it has a headless browser: ${status.error.message}`;
    return { reason: "unknown", message };
  }
  if (!headless.allowRuns) return { reason: "headless-not-allowed", message: `${name} lets no run use its headless browser: browser.headless.allowRuns is off.` };
  if (!headless.availability.available) return { reason: "headless-unavailable", message: headless.availability.reason };
  return null;
};

/**
 * The default: none chosen, which a run of the session resolves at its
 * start to the environment's headless browser when runs may have it and
 * it has one, else to no browser.
 */
const defaultRow = (headless: BrowserUnavailable | null): Unmarked => ({
  value: null,
  label: "Default",
  note: headless === null ? "Currently the headless browser." : `Currently ${headless.reason === "unknown" ? "not known" : "no browser"}. ${headless.message}`,
  unavailable: null,
});

const headlessRow = (unavailable: BrowserUnavailable | null, name: string): Unmarked => ({
  value: { kind: "headless" },
  label: HEADLESS_LABEL,
  note: `A browser on ${name} that nobody can see. Signed in to nothing, and the agent can read, click and type in it.`,
  unavailable,
});

/** The browser dock, in the desktop window beside the session. */
const DOCK_ROW: Unmarked = {
  value: { kind: "dock" },
  label: `${PRODUCT_NAME}'s built-in browser`,
  note: `A tab inside the ${PRODUCT_NAME} window. Signed in to nothing, and the agent can read, click and type in it.`,
  unavailable: null,
};

/** The Chromes one environment lists, with the words that place them. */
interface ChromeGroup {
  readonly environmentId: string;
  readonly chromes: readonly PairedChrome[];
  /** What a label adds so two environments' Chromes stay apart: ` on <name>` when both list some, else nothing. */
  readonly where: string;
  readonly unreachable: boolean;
}

/** The plain My Chrome of the group, where more than one Chrome is paired with its environment: whichever of them is connected. */
const plainRow = (group: ChromeGroup): Unmarked[] =>
  group.chromes.length < 2
    ? []
    : [
        {
          value: { kind: "chrome", environmentId: group.environmentId, chromeId: null },
          label: `${PLAIN_LABEL}${group.where}`,
          note: PLAIN_NOTE,
          unavailable: group.unreachable ? { reason: "unreachable", message: "The Chrome’s environment cannot be reached. This list is cached and stale." } : group.chromes.some((chrome) => chrome.connected)
            ? null
            : { reason: "disconnected", message: `No paired browser is connected. Open Chrome with the ${PRODUCT_NAME} extension enabled.` },
        },
      ];

const chromeRows = (group: ChromeGroup): Unmarked[] => [
  ...plainRow(group),
  ...group.chromes.map((chrome): Unmarked => ({
    value: { kind: "chrome", environmentId: group.environmentId, chromeId: chrome.id },
    label: `${MY_CHROME}: ${chrome.name}${group.where}`,
    note: NAMED_NOTE,
    unavailable: group.unreachable ? { reason: "unreachable", message: "The Chrome’s environment cannot be reached. This list is cached and stale." } : chrome.connected ? null : { reason: "disconnected", message: `${chrome.name} is not connected. Open it with the ${PRODUCT_NAME} extension enabled.` },
  })),
];

const sameId = (a: string | null, b: string | null): boolean => a?.toLowerCase() === b?.toLowerCase();

const sameBrowser = (a: SessionBrowser | null, b: SessionBrowser | null): boolean => {
  if (a === null || b === null) return a === b;
  if (a.kind === "chrome" && b.kind === "chrome") return sameId(a.environmentId, b.environmentId) && sameId(a.chromeId, b.chromeId);
  return a.kind === b.kind;
};

/** The row `chosen` marks: its own, but the plain My Chrome of an environment listing one Chrome is that Chrome's, which it is while that one is all. */
const markedAs = (chosen: SessionBrowser | null, groups: readonly ChromeGroup[]): SessionBrowser | null => {
  if (chosen?.kind !== "chrome" || chosen.chromeId !== null) return chosen;
  const chromes = groups.find((group) => sameId(group.environmentId, chosen.environmentId))?.chromes ?? [];
  return chromes.length === 1 && chromes[0] !== undefined ? { ...chosen, chromeId: chromes[0].id } : chosen;
};

/**
 * The picker's rows for a session on `environmentId` whose browser is
 * `chosen` (undefined while it is not known, which marks none).
 */
export const browserRows = (sources: BrowserSources, environmentId: string, chosen: SessionBrowser | null | undefined): BrowserRow[] => {
  const records = sources.records.read();
  const nameOf = (id: string) => records.find((record) => record.environmentId === id)?.descriptor.name ?? id;
  const listed = chromeEnvironments(records, environmentId)
    .map((id) => ({ environmentId: id, chromes: sources.chromes(id).read().result?.chromes ?? [] }))
    .filter((group) => group.chromes.length > 0);
  const groups = listed.map((group): ChromeGroup => ({ ...group, unreachable: records.find((record) => record.environmentId === group.environmentId)?.phase !== "ready", where: listed.length > 1 ? ` on ${nameOf(group.environmentId)}` : "" }));
  const headless = headlessUnavailable(sources.status(environmentId).read(), nameOf(environmentId));
  const dock = sources.webView.status === "present" ? [DOCK_ROW] : [];
  const rows: Unmarked[] = [defaultRow(headless), ...groups.flatMap(chromeRows), headlessRow(headless, nameOf(environmentId)), { value: { kind: "none" } as const, label: "None", note: "No browser. The run can read the web with web_read alone.", unavailable: null }, ...dock];
  const marked = chosen === undefined ? undefined : markedAs(chosen, groups);
  // A stored field can outlive its pairing or name a machine this client cannot drive.
  // Keep that choice visible instead of presenting it as the default.
  if (chosen?.kind === "chrome" && !rows.some((row) => sameBrowser(row.value, marked ?? null))) {
    const drivable = chromeEnvironments(records, environmentId).includes(chosen.environmentId);
    rows.splice(1, 0, {
      value: chosen,
      label: `${MY_CHROME} on ${nameOf(chosen.environmentId)}`,
      note: chosen.chromeId === null ? PLAIN_NOTE : NAMED_NOTE,
      unavailable: drivable
        ? { reason: "disconnected", message: "This Chrome is not in the paired list. Pair it again or choose another browser." }
        : { reason: "not-drivable", message: "This Chrome is on another machine; no local client can drive it here." },
    });
  }
  return rows.map((row) => ({ ...row, selected: marked !== undefined && sameBrowser(row.value, marked) }));
};

/** `projections.browsers(environmentId, sessionId)`: the session's picker, recomputed as what it reads changes, following only what it reads. */
export const browsersProjection = (host: BrowsersHost, environmentId: string, sessionId: string): Observable<BrowsersView> => {
  const id = sessionId.toLowerCase();
  /** The session's browser as its list row holds it; undefined while the lists do not hold the session. */
  const chosen = () => host.sessionList.read().rows.find((row) => row.environmentId === environmentId && row.summary.id === id)?.summary.browser;
  return dynamic(
    () => [host.sessionList, ...browserInputs(host, environmentId)],
    (): BrowsersView => ({ environmentId, sessionId: id, rows: browserRows(host, environmentId, chosen()), chromes: pairedChromes(host, environmentId), status: host.status(environmentId).read(), dock: host.webView }),
  );
};
