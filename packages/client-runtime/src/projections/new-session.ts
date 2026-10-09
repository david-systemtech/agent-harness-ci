import type { AccountRecord, ModelEntry, SessionBrowser, SessionSummary, WorkspaceRequest } from "@agent-harness/contracts";
import { answerCapability } from "../capabilities.js";
import type { ClientPreferences, ConnectionRecord } from "../connections/records.js";
import { dynamic, type Observable } from "../observable.js";
import type { CachedAnswer } from "../requests.js";
import { identityKey, type AccountsAnswer, type ModelsAnswer, type UsageGauge, type UsageView } from "./accounts.js";
import { browserInputs, browserRows, localEnvironmentOf, type BrowserRow, type BrowserSources } from "./browsers.js";
import type { EnvironmentView } from "./environments.js";
import { directoryUsedBy, type KnownDirectory } from "./known-directories.js";
import type { SessionListView, SessionRow } from "./session-list.js";

/**
 * `projections.newSession(context)` (workspace-picker spec, "The picker in
 * the client runtime"; ADR 0005): starting a session begins with where. A
 * pure projection (ADR 0003) of the connection registry, the session lists,
 * the request cache and the client-local `environments.lastUsed`, given what
 * the renderer has in focus and the chips already set. It answers each
 * chip's preset, the reason for it and its options, in the card's order:
 * environment, account, model (with the first run's effort), workspace,
 * browser.
 */

/** What the new-session card is opened on: what the sidebar or the rail has in focus. */
export type NewSessionFocus =
  | { readonly kind: "none" }
  | { readonly kind: "session"; readonly environmentId: string; readonly sessionId: string }
  /** A merged group heading, by its key (`MergedGroupHeading.key`). */
  | { readonly kind: "group"; readonly key: string }
  /** A by-repository heading. */
  | { readonly kind: "repository"; readonly repositoryIdentity: string }
  /** An environment heading's own new-session action, or the terminal UI's `--environment`. */
  | { readonly kind: "environment"; readonly environmentId: string };

/**
 * The chips already set on the card. A chip set on another environment than
 * the one the card now starts on (the environment chip moved after it) is
 * kept where the new environment has what it holds: an account's login, a
 * model the account offers.
 */
export interface NewSessionChips {
  readonly environmentId?: string;
  /** The account chosen, with the environment it was chosen on. */
  readonly account?: { readonly environmentId: string; readonly accountId: string };
  /** The model chosen, by id. */
  readonly model?: string;
  /** The first run's effort chosen for `model`, null for the model's own; used only when that model takes it (`EffortChip`). */
  readonly effort?: string | null;
  /** The workspace chosen, with the environment it was chosen on: another environment keeps its repository, or scratch. */
  readonly workspace?: { readonly environmentId: string; readonly request: WorkspaceRequest };
  /** The browser chosen: what the session starts with, null for the default (none chosen, which each run resolves). */
  readonly browser?: SessionBrowser | null;
}

export interface NewSessionContext {
  readonly focus: NewSessionFocus;
  readonly chips?: NewSessionChips;
}

/**
 * Why the environment chip holds what it holds: `chosen` (the chip was
 * set), then ADR 0005's rule, step by step: `heading` (an environment
 * heading's action), `session` (the focused session's), `group` (a focused
 * merged heading's), `repository` (an environment holding the repository in
 * focus), `last-used`, `local` (this machine's), `first-enabled`; or
 * `none-usable` when every step passed over every environment, and the chip
 * asks.
 */
export type EnvironmentPresetReason = "chosen" | "heading" | "session" | "group" | "repository" | "last-used" | "local" | "first-enabled" | "none-usable";

/** One environment the chip offers. */
export interface EnvironmentOption {
  readonly environment: EnvironmentView;
  /**
   * Why no session can start there now, in the capability's one line: it
   * cannot be reached, is disabled or is not ready (or the connection lacks
   * the scope). Such an option is greyed and never preset. Null when a
   * session can start there.
   */
  readonly unusable: string | null;
}

export interface EnvironmentChip {
  /** The environment the session starts on; null when none is usable. */
  readonly value: string | null;
  readonly reason: EnvironmentPresetReason;
  /** Every environment this client knows, in the connection list's order. */
  readonly options: readonly EnvironmentOption[];
}

/**
 * Why the account chip holds what it holds: `chosen` (set on this
 * environment), `kept` (the login of one set on another environment),
 * `session` (the focused session's login, ADR 0018), `default`
 * (`accounts.defaultAccount`), `first-signed-in`; `none` when the
 * environment holds no signed-in account (or none is read yet, or no
 * environment is chosen), and the chip asks.
 */
export type AccountPresetReason = "chosen" | "kept" | "session" | "default" | "first-signed-in" | "none";

export interface AccountChip {
  /** The account the session's runs use: one of the environment's, signed in unless chosen; null when none is. */
  readonly value: AccountRecord | null;
  readonly reason: AccountPresetReason;
  /** The plan gauge of the account's login, pooled across environments (`projections.usage`); null while no reading of it is held. */
  readonly gauge: UsageGauge | null;
  /** The environment's accounts, as it lists them. */
  readonly options: readonly AccountRecord[];
}

/**
 * Why the model chip holds what it holds: `chosen`, `session` (the focused
 * session's), `default` (the account's: the strongest of
 * `accounts.defaultModelFamily`, else its strongest); `none` without an
 * account or its models.
 */
export type ModelPresetReason = "chosen" | "session" | "default" | "none";

export interface ModelChip {
  readonly value: ModelEntry | null;
  readonly reason: ModelPresetReason;
  /** The models the account offers. */
  readonly options: readonly ModelEntry[];
}

/**
 * Why the first run's effort is what it is (#1950): `chosen` (set for the
 * model chip's model, which takes it; null, the model's own, among them),
 * `default` (`accounts.defaultEffort`, which the model takes, as the
 * environment applies it to a run that names none); `own` otherwise (the
 * model takes no effort, or no default it takes is set); `none` without a
 * model.
 */
export type EffortPresetReason = "chosen" | "default" | "own" | "none";

export interface EffortChip {
  /** The effort the first run goes out at; null for the model's own. */
  readonly value: string | null;
  readonly reason: EffortPresetReason;
}

/**
 * Why the workspace chip holds what it holds: `chosen` (set on this
 * environment), `kept` (the repository of one set on another environment,
 * or scratch), `session` (the focused session's, shared), `repository` (the
 * most recently used directory there with the identity in focus), `recent`
 * (the environment's most recently used directory), `scratch`; `none` when
 * no environment is chosen.
 */
export type WorkspacePresetReason = "chosen" | "kept" | "session" | "repository" | "recent" | "scratch" | "none";

export interface WorkspaceChip {
  /** The request `sessions.create` resolves on the environment; null when no environment is chosen. */
  readonly value: WorkspaceRequest | null;
  readonly reason: WorkspacePresetReason;
  /** The environment's known directories (`projections.knownDirectories`), a gone one with its mark. */
  readonly options: readonly KnownDirectory[];
}

/**
 * Why the browser chip holds what it holds: `chosen` (set, and a Chrome
 * only while it is of the local environment or of the one chosen), `reach`
 * (the account's `browser.reach` names a Chrome of the local environment or
 * of the one chosen, which drive it directly); `none` otherwise: the
 * account's reach is `per-session` (or not set), it names another
 * environment's Chrome, or no account or reach is read yet.
 */
export type BrowserPresetReason = "chosen" | "reach" | "none";

export interface BrowserChip {
  /** The browser the session starts with (`sessions.create`'s `browser`); null for none chosen, which each run resolves. */
  readonly value: SessionBrowser | null;
  readonly reason: BrowserPresetReason;
  /** The picker's rows for a session on the environment chosen (`projections.browsers`), the chip's value marked. */
  readonly options: readonly BrowserRow[];
}

export interface NewSessionView {
  readonly environment: EnvironmentChip;
  readonly account: AccountChip;
  readonly model: ModelChip;
  readonly effort: EffortChip;
  readonly workspace: WorkspaceChip;
  readonly browser: BrowserChip;
}

/** The card's sources, the browser picker's among them: its connection list, each environment's paired Chromes and browser status, and the shell's `webView`. */
export interface NewSessionHost extends BrowserSources {
  readonly environments: Observable<readonly EnvironmentView[]>;
  readonly sessionList: Observable<SessionListView>;
  readonly preferences: Observable<ClientPreferences>;
  /** Plan usage pooled by login (`projections.usage`). */
  readonly usage: Observable<UsageView>;
  /** The environment's accounts (`projections.accounts`): the same observable for each. */
  accounts(environmentId: string): Observable<AccountsAnswer>;
  /** The models the environment's accounts offer (`projections.models`). */
  models(environmentId: string): Observable<ModelsAnswer>;
  /** The environment's known directories, less those this client hides (`projections.knownDirectories`). */
  knownDirectories(environmentId: string): Observable<readonly KnownDirectory[]>;
  /** The settings the presets read (`PRESET_SETTING_KEYS`), from the request cache. */
  defaults(environmentId: string): Observable<CachedAnswer<"settings.get">>;
}

/** The settings the account, model, effort and browser presets read. */
export const PRESET_SETTING_KEYS = ["accounts.defaultAccount", "accounts.defaultModelFamily", "accounts.defaultEffort", "browser.reach"] as const;

/** Why no session can start on the environment now: the first capability a new session needs that is absent, in its line. */
const unusableReason = (record: ConnectionRecord | undefined): string | null => {
  for (const method of ["sessions.create", "runs.start"] as const) {
    const answer = answerCapability(method, record, undefined);
    if (answer.status === "absent") return answer.message;
  }
  return null;
};

/** The focused session's row, when the focus is a session the lists hold. */
const focusedRow = (focus: NewSessionFocus, list: SessionListView): SessionRow | undefined =>
  focus.kind === "session" ? list.rows.find((row) => row.environmentId === focus.environmentId && row.summary.id === focus.sessionId.toLowerCase()) : undefined;

/** One step of the environment rule: its reason, and the environments it names in its own order. */
interface Step {
  readonly reason: EnvironmentPresetReason;
  readonly candidates: readonly (string | undefined)[];
}

/** When a session was last active: its last activity, else its creation. */
const lastUse = (summary: SessionSummary): number => Date.parse(summary.lastActivityAt ?? summary.createdAt);

/** The environments of `rows`, the one with the most recently active session first. */
const byRecentSession = (rows: readonly SessionRow[]): string[] => [
  ...new Set([...rows].sort((a, b) => lastUse(b.summary) - lastUse(a.summary)).map((row) => row.environmentId)),
];

/** ADR 0005's environment rule for `focus`, step by step; each step's candidates are tried in order, and an unusable one is passed over. */
const environmentSteps = (focus: NewSessionFocus, records: readonly ConnectionRecord[], list: SessionListView, lastUsed: string | null): Step[] => {
  const steps: Step[] = [];
  const focused = focusedRow(focus, list);
  if (focus.kind === "environment") steps.push({ reason: "heading", candidates: [focus.environmentId] });
  if (focus.kind === "session") steps.push({ reason: "session", candidates: [focus.environmentId] });
  if (focus.kind === "group") {
    const heading = list.groups.find((group) => group.key === focus.key);
    if (heading !== undefined) {
      const members = heading.groups.map((member) => member.environmentId);
      const primary = records[0]?.environmentId;
      const inHeading = list.rows.filter((row) => heading.groups.some((member) => member.environmentId === row.environmentId && member.groupId === row.summary.groupId));
      // The primary if it holds a member group, else the environment of the most recently active session; a heading with no
      // session left falls to its members in the connection list's order.
      steps.push({ reason: "group", candidates: [primary !== undefined && members.includes(primary) ? primary : undefined, ...byRecentSession(inHeading), ...members] });
    }
  }
  const identity = focus.kind === "repository" ? focus.repositoryIdentity : (focused?.summary.repositoryIdentity ?? null);
  if (identity !== null) {
    // Holding a repository is having a non-deleted session with its identity: the focused session's environment, else the
    // last used among the holders, else the holder with the most recent such session.
    const holders = byRecentSession(list.rows.filter((row) => row.summary.repositoryIdentity === identity));
    steps.push({ reason: "repository", candidates: [focused?.environmentId, holders.find((holder) => holder === lastUsed), ...holders] });
  }
  const local = localEnvironmentOf(records);
  steps.push({ reason: "last-used", candidates: [lastUsed ?? undefined] });
  steps.push({ reason: "local", candidates: [local ?? undefined] });
  steps.push({ reason: "first-enabled", candidates: records.filter((record) => record.enabled).map((record) => record.environmentId) });
  return steps;
};

const environmentChip = (context: NewSessionContext, records: readonly ConnectionRecord[], environments: readonly EnvironmentView[], list: SessionListView, preferences: ClientPreferences): EnvironmentChip => {
  const byId = new Map(records.map((record) => [record.environmentId, record]));
  const options = environments.map((environment): EnvironmentOption => ({ environment, unusable: unusableReason(byId.get(environment.environmentId)) }));
  const usable = new Set(options.filter((option) => option.unusable === null).map((option) => option.environment.environmentId));
  const chosen = context.chips?.environmentId;
  if (chosen !== undefined && byId.has(chosen)) return { value: chosen, reason: "chosen", options };
  for (const step of environmentSteps(context.focus, records, list, preferences["environments.lastUsed"])) {
    const found = step.candidates.find((candidate) => candidate !== undefined && usable.has(candidate));
    if (found !== undefined) return { value: found, reason: step.reason, options };
  }
  return { value: null, reason: "none-usable", options };
};

/** The chips after the environment when none is chosen. */
const NO_ACCOUNT: AccountChip = { value: null, reason: "none", gauge: null, options: [] };
const NO_MODEL: ModelChip = { value: null, reason: "none", options: [] };
const NO_EFFORT: EffortChip = { value: null, reason: "none" };
const NO_WORKSPACE: WorkspaceChip = { value: null, reason: "none", options: [] };
const NO_BROWSER: BrowserChip = { value: null, reason: "none", options: [] };

/** What the chips after the environment read: the card's context, the session lists, the focused session's row, and the environment chosen. */
interface Card {
  readonly host: NewSessionHost;
  readonly context: NewSessionContext;
  readonly list: SessionListView;
  readonly focused: SessionRow | undefined;
  readonly environmentId: string;
}

/** The environments whose accounts the account chip reads: the chosen one, the one a chosen account is on, and the focused session's. */
const accountSources = (card: Card): string[] => {
  const on = [card.environmentId, card.context.chips?.account?.environmentId, card.focused?.summary.accountId != null ? card.focused.environmentId : undefined];
  return [...new Set(on.filter((id) => id !== undefined))];
};

const signedIn = (account: AccountRecord): boolean => account.status.state === "signed-in";

const accountChip = ({ host, context, focused, environmentId }: Card): AccountChip => {
  const options = host.accounts(environmentId).read().value ?? [];
  const usable = options.filter(signedIn);
  /** The account here with the login of `accountId` on its environment: itself here, else the signed-in account with its identity (ADR 0018). */
  const withLoginOf = (on: string, accountId: string): AccountRecord | undefined => {
    if (on === environmentId) return usable.find((account) => account.id === accountId);
    const identity = host.accounts(on).read().value?.find((account) => account.id === accountId)?.identity;
    return identity == null ? undefined : usable.find((account) => account.identity !== null && identityKey(account.identity) === identityKey(identity));
  };
  const pick = (): Pick<AccountChip, "value" | "reason"> => {
    const chosen = context.chips?.account;
    const own = chosen?.environmentId === environmentId ? options.find((account) => account.id === chosen.accountId) : undefined;
    if (own !== undefined) return { value: own, reason: "chosen" };
    const kept = chosen !== undefined && chosen.environmentId !== environmentId ? withLoginOf(chosen.environmentId, chosen.accountId) : undefined;
    if (kept !== undefined) return { value: kept, reason: "kept" };
    const session = focused?.summary.accountId != null ? withLoginOf(focused.environmentId, focused.summary.accountId) : undefined;
    if (session !== undefined) return { value: session, reason: "session" };
    const named = host.defaults(environmentId).read().result?.values["accounts.defaultAccount"];
    const preset = usable.find((account) => account.id === named);
    if (preset !== undefined) return { value: preset, reason: "default" };
    const first = usable[0];
    return first !== undefined ? { value: first, reason: "first-signed-in" } : { value: null, reason: "none" };
  };
  const { value, reason } = pick();
  const pools = (gauge: UsageGauge) => gauge.accounts.some((account) => account.environmentId === environmentId && account.accountId === value?.id);
  return { value, reason, gauge: value === null ? null : (host.usage.read().gauges.find(pools) ?? null), options };
};

/** The account's default model: the strongest of the default family when the account offers it, else its strongest. */
const defaultModel = (models: readonly ModelEntry[], family: string | null | undefined): ModelEntry | undefined => {
  const ofFamily = models.filter((model) => model.family === family);
  return [...(ofFamily.length > 0 ? ofFamily : models)].sort((a, b) => b.tier - a.tier)[0];
};

const modelChip = ({ host, context, focused, environmentId }: Card, account: AccountRecord | null): ModelChip => {
  if (account === null) return NO_MODEL;
  const options = host.models(environmentId).read().value?.find((catalogue) => catalogue.accountId === account.id)?.models ?? [];
  const offered = (id: string | null | undefined) => options.find((model) => model.id === id);
  const chosen = offered(context.chips?.model);
  if (chosen !== undefined) return { value: chosen, reason: "chosen", options };
  const session = offered(focused?.summary.model);
  if (session !== undefined) return { value: session, reason: "session", options };
  const preset = defaultModel(options, host.defaults(environmentId).read().result?.values["accounts.defaultModelFamily"]);
  return preset !== undefined ? { value: preset, reason: "default", options } : { value: null, reason: "none", options };
};

const effortChip = ({ host, context, environmentId }: Card, model: ModelEntry | null): EffortChip => {
  if (model === null) return NO_EFFORT;
  const chosen = context.chips?.effort;
  if (context.chips?.model === model.id && chosen !== undefined && (chosen === null || model.efforts.includes(chosen))) return { value: chosen, reason: "chosen" };
  const preset = host.defaults(environmentId).read().result?.values["accounts.defaultEffort"];
  return preset != null && model.efforts.includes(preset) ? { value: preset, reason: "default" } : { value: null, reason: "own" };
};

/** The repository identity of a workspace chosen on `environmentId`: of the session it names, else of a session using its directory; null when none is known. */
const identityOfChoice = (list: SessionListView, environmentId: string, request: WorkspaceRequest): string | null => {
  const rows = list.rows.filter((row) => row.environmentId === environmentId);
  if (request.kind === "session") return rows.find((row) => row.summary.id === request.sessionId.toLowerCase())?.summary.repositoryIdentity ?? null;
  const path = request.kind === "directory" ? request.path : request.kind === "worktree" ? request.repository : null;
  const using = rows.find((row) => path !== null && row.summary.repositoryIdentity !== null && directoryUsedBy(row.summary)?.path === path);
  return using?.summary.repositoryIdentity ?? null;
};

const workspaceChip = ({ host, context, list, focused, environmentId }: Card): WorkspaceChip => {
  const options = host.knownDirectories(environmentId).read();
  /** The most recently used directory there that is not gone, holding the repository `identity` when one is named. */
  const directoryWith = (identity?: string): WorkspaceRequest | undefined => {
    const found = options.find((known) => known.missingSince === null && (identity === undefined || known.repositoryIdentity === identity));
    return found === undefined ? undefined : { kind: "directory", path: found.path };
  };
  const chosen = context.chips?.workspace;
  if (chosen?.environmentId === environmentId) return { value: chosen.request, reason: "chosen", options };
  if (chosen !== undefined) {
    // Moved from the environment it was chosen on: scratch is scratch anywhere; a repository is its directory here.
    if (chosen.request.kind === "scratch") return { value: { kind: "scratch" }, reason: "kept", options };
    const identity = identityOfChoice(list, chosen.environmentId, chosen.request);
    const kept = identity === null ? undefined : directoryWith(identity);
    if (kept !== undefined) return { value: kept, reason: "kept", options };
  }
  if (focused?.environmentId === environmentId && focused.summary.workspaceMissingSince === null) {
    return { value: { kind: "session", sessionId: focused.summary.id }, reason: "session", options };
  }
  // The repository in focus: a repository heading's, else the focused session's (its own workspace gone, or the chip moved).
  const identity = context.focus.kind === "repository" ? context.focus.repositoryIdentity : focused?.summary.repositoryIdentity;
  const holding = identity == null ? undefined : directoryWith(identity);
  if (holding !== undefined) return { value: holding, reason: "repository", options };
  const recent = directoryWith();
  if (recent !== undefined) return { value: recent, reason: "recent", options };
  return { value: { kind: "scratch" }, reason: "scratch", options };
};

/** Whether a session on `environmentId` can be started with `browser`: a Chrome only of the local environment or of that one, either of which drives it directly. */
const drivable = (browser: SessionBrowser | null, environmentId: string, local: string | null): boolean =>
  browser?.kind !== "chrome" || [environmentId, local].some((id) => id?.toLowerCase() === browser.environmentId.toLowerCase());

const browserChip = ({ host, context, environmentId }: Card, account: AccountRecord | null): BrowserChip => {
  const local = localEnvironmentOf(host.records.read());
  const pick = (): Pick<BrowserChip, "value" | "reason"> => {
    const chosen = context.chips?.browser;
    if (chosen !== undefined && drivable(chosen, environmentId, local)) return { value: chosen, reason: "chosen" };
    const reach = account === null ? undefined : host.defaults(environmentId).read().result?.values["browser.reach"]?.[account.id];
    if (reach === undefined || reach === "per-session") return { value: null, reason: "none" };
    const chrome: SessionBrowser = { kind: "chrome", ...reach.chrome };
    return drivable(chrome, environmentId, local) ? { value: chrome, reason: "reach" } : { value: null, reason: "none" };
  };
  const { value, reason } = pick();
  return { value, reason, options: browserRows(host, environmentId, value) };
};

/** `projections.newSession(context)`: the card's chips, recomputed as what they read changes, following only what they read. */
export const newSessionProjection = (host: NewSessionHost, context: NewSessionContext): Observable<NewSessionView> => {
  const environment = (): EnvironmentChip => environmentChip(context, host.records.read(), host.environments.read(), host.sessionList.read(), host.preferences.read());
  /** The chips after the environment read on the environment chosen; none when none is. */
  const cardOn = (environmentId: string | null): Card | null => {
    if (environmentId === null) return null;
    const list = host.sessionList.read();
    return { host, context, list, focused: focusedRow(context.focus, list), environmentId };
  };
  return dynamic(
    () => {
      const base = [host.records, host.environments, host.sessionList, host.preferences, host.usage];
      const card = cardOn(environment().value);
      if (card === null) return base;
      const { environmentId } = card;
      return [
        ...base,
        ...accountSources(card).map((id) => host.accounts(id)),
        host.models(environmentId),
        host.defaults(environmentId),
        host.knownDirectories(environmentId),
        ...browserInputs(host, environmentId),
      ];
    },
    (): NewSessionView => {
      const where = environment();
      const card = cardOn(where.value);
      if (card === null) return { environment: where, account: NO_ACCOUNT, model: NO_MODEL, effort: NO_EFFORT, workspace: NO_WORKSPACE, browser: NO_BROWSER };
      const account = accountChip(card);
      const model = modelChip(card, account.value);
      return { environment: where, account, model, effort: effortChip(card, model.value), workspace: workspaceChip(card), browser: browserChip(card, account.value) };
    },
  );
};
