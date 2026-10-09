import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import {
  BETWEEN_ENVIRONMENTS,
  addAccount as addAccountOn,
  cancelSignIn as cancelSignInOn,
  describeKey,
  fallbackOf,
  followedSignIn,
  handOff as handOffOnto,
  handedOffAlreadyWords,
  handingOffWords,
  labelProblem,
  modelDisplayName,
  modelsOf,
  noKeysLine,
  oneLine,
  onLocalDayChange,
  outcomeWords,
  parseTyped,
  pullSetupSources,
  runTool,
  restoreStep,
  saveSetting,
  setupActions,
  sendSignInCode,
  sessionModeOf,
  setSessionContainment,
  setSessionMode,
  setSessionModel,
  signInEnd,
  startSignIn as startSignInOf,
  startingAccount,
  updateEnvironment,
  valueWords,
  writerOf,
  type Clock,
  type EnvironmentView,
  type OfferedSetupAction,
  type RunChoice,
  type Runtime,
  type SessionProjection,
} from "@agent-harness/client-runtime";
import {
  BYPASS_SENTENCE,
  CONTAINMENT_LEVELS,
  MODES,
  compareModes,
  isSettingsRowId,
  settingForm,
  type AccountRecord,
  type ContainmentLevel,
  type KeyActionId,
  type Mode,
  type ModelEntry,
  type SettingsKey,
  type ResultOf,
} from "@agent-harness/contracts";
import { TERMINAL_ROLES } from "@agent-harness/theme";
import { LinesCard } from "../screens/transcript.js";
import type { Opened } from "../session/use-session.js";
import { useFollow } from "../session/use-session.js";
import { meterCells } from "../status/line.js";
import { wrap, type Line, type Span } from "../transcript/lines.js";
import { findEnvironment, isPlaceholder, knownEnvironments, nameOf, type Question } from "../view.js";
import { ListCard, LinesPanel, TypedLine, wrappedRows } from "./cards.js";
import type { PickerCommand } from "./commands.js";
import { accountRows, containmentRows, effortRows, modeFooter, modeRows, modelRows, reviewLines, setupLines, setupRows, setupStepWords, usageLines, type Panel, type PanelRow } from "./panel.js";
import { editorKeys, editorRows, noRowLine, settingLabel } from "./settings.js";

/**
 * The accounts, models, permissions, settings and Set up commands wired to
 * the runtime (docs/specs/tui.md, "Status, usage, pickers" and "Set up: the
 * summary and the pointer"; #147). The open card is the app's (`Panel`,
 * held in its card); this hook follows what the card shows, runs what the
 * keys choose, and keeps, in memory only, what this terminal chose for a
 * session's next runs: the model and effort `/model` chose (sent with its
 * next `runs.start`), the containment level it set and the account it
 * handed a session off onto (read by the status line, since no summary
 * carries either).
 *
 * The runtime answers who may do what: an `admin` call is a direct request
 * (`requests.call`), a `runs:drive` or `sessions:write` command goes through
 * the outbox (`commands.dispatch`), and a capability the connection lacks is
 * the runtime's one line (`capability`).
 */

export interface PickersHost {
  readonly runtime: Runtime;
  /** The platform's clock: the day `/usage` says a window resets on is counted from it. */
  readonly clock: Clock;
  readonly request: () => void;
  readonly views: readonly EnvironmentView[];
  /** The header's environment: where a command acts with no session open. */
  readonly current: EnvironmentView | undefined;
  readonly opened: Opened | null;
  readonly projection: SessionProjection | undefined;
  /** The open card, when it is one of these. */
  readonly panel: Panel | undefined;
  open(panel: Panel): void;
  /** Changes the open card while it is still one of these, of the same kind. */
  change(update: (panel: Panel) => Panel): void;
  /** Closes the open card while it is one of these, and, with `when`, only while `when` holds of it. */
  close(when?: (panel: Panel) => boolean): void;
  say(line: string): void;
  ask(question: Question): void;
  openSession(opened: Opened): void;
  openTool(environmentId: string, run: ResultOf<"tools.run">): void;
  startService(environmentId: string): void;
  newCommandId(): string;
  keys(action: KeyActionId): string;
}

export interface Pickers {
  /** Runs a command of `PICKER_COMMANDS`. */
  run(command: PickerCommand): void;
  /** Shift+Tab (`app.mode.step`): the session's mode stepped to the next the ceiling allows. */
  stepMode(): void;
  /** How many rows the card's list has. */
  rows(panel: Panel): number;
  move(panel: Panel, step: number): Panel;
  /** Enter. */
  choose(panel: Panel): void;
  nextSetupAction(panel: Panel, direction: number): Panel;
  /** Esc: the card to go back to, or null to close it (a running sign-in this card started is cancelled). */
  back(panel: Panel): Panel | null;
  /** The card takes what is typed as text (a label, a code, a value). */
  takesText(panel: Panel): boolean;
  typed(panel: Panel, text: string): Panel;
  erased(panel: Panel): Panel;
  /** A card of lines, scrolled by the pager's keys rather than moved. */
  isLines(panel: Panel): boolean;
  scroll(panel: Panel, to: (top: number) => number): Panel;
  hint(panel: Panel): string;
  render(panel: Panel, size: { readonly width: number; readonly height: number }): ReactElement;
  /** The containment level this terminal set on the session. */
  containment(opened: Opened | null): ContainmentLevel | undefined;
  /** The account this terminal handed the session off onto, until a run of it says its own. */
  forkedOnto(opened: Opened | null): string | undefined;
}

const keyOf = (opened: Opened) => `${opened.environmentId} ${opened.sessionId}`;

/** An answer that comes after a card was replaced closes only the card it was for: a sign-in's. */
const isSignIn = (panel: Panel): boolean => panel.kind === "signin";

const clamp = (cursor: number, rows: number): number => (rows <= 0 ? 0 : Math.min(Math.max(cursor, 0), rows - 1));

export const usePickers = (host: PickersHost): Pickers => {
  const { runtime, clock, request, panel, opened, projection, views } = host;
  const [levels, setLevels] = useState<ReadonlyMap<string, ContainmentLevel>>(new Map());
  const [forks, setForks] = useState<ReadonlyMap<string, string>>(new Map());
  // The lines a card of lines drew last: what its scroll is clamped to.
  const drawn = useRef({ lines: 0, height: 1 });
  // A completed check only finishes the card that started it, even when /setup was reopened on the same environment.
  const setupCheck = useRef(0);
  const latestPanel = useRef(panel);
  latestPanel.current = panel;
  // The mode each session was last asked for, until its answer lands: what a step taken before then steps on from.
  const asked = useRef(new Map<string, Mode>());

  const environmentOf = (environmentId: string): EnvironmentView | undefined => views.find((v) => v.environmentId === environmentId);
  const nameFor = (environmentId: string): string => {
    const view = environmentOf(environmentId);
    return view ? nameOf(view) : "the environment";
  };
  const sessionName = (): string => projection?.summary?.title ?? "this session";
  const sessionAccount = (): string | null => projection?.summary?.accountId ?? (opened ? (forks.get(keyOf(opened)) ?? null) : null);

  // What the open card shows, followed while it is open.
  const kind = panel?.kind;
  useEffect(() => {
    if (kind !== "usage") return;
    const timer = onLocalDayChange(clock, request);
    return () => timer.cancel();
  }, [clock, kind, request]);
  const panelEnvironment = panel !== undefined && "environmentId" in panel ? panel.environmentId : undefined;
  const accounts = useMemo(() => (panelEnvironment !== undefined ? runtime.projections.accounts(panelEnvironment) : undefined), [runtime, panelEnvironment]);
  useFollow(kind === "accounts" || kind === "signin" || kind === "models" ? accounts : undefined, request);
  useFollow(kind === "accounts" || kind === "usage" ? runtime.projections.usage : undefined, request);
  const models = useMemo(() => (kind === "models" && panelEnvironment !== undefined ? runtime.projections.models(panelEnvironment) : undefined), [runtime, kind, panelEnvironment]);
  useFollow(models, request);
  const modes = useMemo(() => (panelEnvironment !== undefined ? runtime.projections.modes(panelEnvironment) : undefined), [runtime, panelEnvironment]);
  useFollow(kind === "modes" ? modes : undefined, request);
  const permissions = useMemo(
    () => (kind === "containment" && panelEnvironment !== undefined ? runtime.requests.cached(panelEnvironment, "permissions.settings.get", {}) : undefined),
    [runtime, kind, panelEnvironment],
  );
  useFollow(permissions, request);
  const setup = useMemo(() => (kind === "setup" && panelEnvironment !== undefined ? runtime.projections.setup(panelEnvironment) : undefined), [runtime, kind, panelEnvironment]);
  // Without the stream flag following itself starts a check. The command already starts one, so draw that answer instead.
  const liveSetup = panelEnvironment !== undefined && environmentOf(panelEnvironment)?.flags.includes("setup") === true;
  useFollow(liveSetup ? setup : undefined, request);
  const needsTools = panelEnvironment !== undefined && setup?.read().steps.some((step) => step.result?.targets?.some((target) => target.kind === "tool" && target.action === "update")) === true && runtime.capability(panelEnvironment, "tools.list").status !== "absent";
  const setupTools = useMemo(() => needsTools && panelEnvironment !== undefined ? runtime.requests.cached(panelEnvironment, "tools.list", {}) : undefined, [runtime, needsTools, panelEnvironment]);
  useFollow(setupTools, request);

  const signIn = useMemo(
    () => (kind === "signin" && panelEnvironment !== undefined ? runtime.requests.cached(panelEnvironment, "accounts.signin.get", {}) : undefined),
    [runtime, kind, panelEnvironment],
  );
  useFollow(signIn, request);
  const handingFrom = panel?.kind === "accounts" && panel.purpose === "handoff" ? sessionAccount() : null;
  const recommendation = useMemo(
    () => (handingFrom !== null && panelEnvironment !== undefined ? runtime.requests.cached(panelEnvironment, "accounts.handoff.recommend", { fromAccountId: handingFrom }) : undefined),
    [runtime, handingFrom, panelEnvironment],
  );
  useFollow(recommendation, request);
  // `/usage` names each pooled account by its label: every environment's accounts are followed while it is open.
  useEffect(() => {
    if (kind !== "usage") return;
    const stops = views.map((view) => runtime.projections.accounts(view.environmentId).subscribe(request));
    return () => stops.forEach((stop) => stop());
  }, [runtime, kind, views, request]);

  const accountList = (): readonly AccountRecord[] => accounts?.read().value ?? [];

  /** The sign-in the card follows: its account's, from when the card started it on (the runtime's rule, #402). */
  const followed = (card: Extract<Panel, { kind: "signin" }>) =>
    followedSignIn(signIn?.read().result?.signIn, { accountId: card.accountId, startedAt: card.startedAt, starting: card.sending === "start" });

  // A sign-in this card follows that ends closes it, and its end is said in one line: what happened, since the
  // terminal has no Start again (the account picker signs the account in again).
  const followedNow = panel?.kind === "signin" ? followed(panel) : undefined;
  const ending = panel?.kind === "signin" && followedNow ? signInEnd(followedNow, panel.label)?.title : undefined;
  useEffect(() => {
    if (ending === undefined) return;
    host.close(isSignIn);
    host.say(ending);
    if (followedNow?.state === "done" && panel?.kind === "signin") void runtime.setup.check(panel.environmentId, "account");
  }, [ending]);

  /** The line a capability the connection lacks gives, or undefined when it has it. */
  const lacking = (environmentId: string, method: "accounts.add" | "accounts.signin.start" | "settings.update"): string | undefined => {
    const answer = runtime.capability(environmentId, method);
    return answer.status === "absent" ? answer.message : undefined;
  };

  // Sign-in.

  const startSignIn = (environmentId: string, account: AccountRecord) => {
    const absent = lacking(environmentId, "accounts.signin.start");
    if (absent !== undefined) return host.say(`Cannot sign ${account.label} in on ${nameFor(environmentId)}: ${absent}`);
    host.open({ kind: "signin", environmentId, label: account.label, accountId: account.id, startedAt: null, sending: "start", text: "", error: null });
    void startSignInOf(runtime, environmentId, account, host.newCommandId()).then((answer) => {
      if (!answer.ok) {
        host.close(isSignIn);
        return host.say(answer.line);
      }
      void runtime.setup.check(environmentId, "account");
      host.change((card) => (card.kind === "signin" && card.accountId === account.id ? { ...card, sending: null, startedAt: answer.startedAt } : card));
    });
  };

  const addAccount = (card: Extract<Panel, { kind: "signin" }>) => {
    const label = card.text.trim();
    const problem = labelProblem(label);
    if (problem !== undefined) return host.change((c) => (c.kind === "signin" ? { ...c, error: problem } : c));
    host.change((c) => (c.kind === "signin" ? { ...c, label, sending: "add", error: null } : c));
    void addAccountOn(runtime, card.environmentId, label, host.newCommandId(), nameFor(card.environmentId)).then((added) => {
      if (added.kind === "refused") return host.change((c) => (c.kind === "signin" ? { ...c, sending: null, error: added.line } : c));
      void runtime.setup.check(card.environmentId, "account");
      if (added.kind === "added") {
        host.close(isSignIn);
        return host.say(added.line);
      }
      host.change((c) => (c.kind === "signin" ? { ...c, accountId: added.account.id, sending: null, text: "" } : c));
    });
  };

  const sendCode = (card: Extract<Panel, { kind: "signin" }>) => {
    const code = card.text.trim();
    if (code === "" || card.accountId === null) return;
    host.change((c) => (c.kind === "signin" ? { ...c, sending: "code", error: null } : c));
    void sendSignInCode(runtime, card.environmentId, card.accountId, code, host.newCommandId()).then((sent) => {
      if (sent.kind === "taken") void runtime.setup.check(card.environmentId, "account");
      host.change((c) => (c.kind === "signin" ? { ...c, sending: null, ...(sent.kind === "taken" ? { text: "" } : { error: sent.kind === "refused" ? sent.ending.line : sent.line }) } : c));
    });
  };

  const cancelSignIn = (card: Extract<Panel, { kind: "signin" }>) => {
    if (card.accountId === null) return;
    void cancelSignInOn(runtime, card.environmentId, { id: card.accountId, label: card.label }, host.newCommandId()).then(({ line }) => host.say(line));
  };

  // Hand-off and the session's own settings.

  const handOff = (environmentId: string, account: AccountRecord) => {
    if (!opened) return host.say("No session is open to hand off: /resume opens one, /new starts one, and its account is chosen as it starts.");
    if (environmentId !== opened.environmentId) return host.say(`Not handed off to ${nameFor(environmentId)}: ${BETWEEN_ENVIRONMENTS}.`);
    const sessionId = opened.sessionId;
    const from = sessionName();
    if (account.id === sessionAccount()) return host.say(handedOffAlreadyWords(from, account));
    host.close();
    host.say(handingOffWords(from, account));
    // A session cannot change its account (runs.start takes none): the hand-off is the runtime's fork onto it (#402).
    void handOffOnto(runtime, environmentId, sessionId, account, from).then((handed) => {
      if (!handed.ok) return host.say(handed.line);
      setForks((held) => new Map(held).set(keyOf({ environmentId, sessionId: handed.sessionId }), account.id));
      host.openSession({ environmentId, sessionId: handed.sessionId });
      host.say(handed.line);
    });
  };

  const setMode = (target: Opened, mode: Mode) => {
    asked.current.set(keyOf(target), mode);
    void setSessionMode(runtime, target.environmentId, target.sessionId, mode, sessionName()).then((set) => {
      if (asked.current.get(keyOf(target)) === mode) asked.current.delete(keyOf(target));
      host.say(set.line);
      if (set.ok) void runtime.setup.check(target.environmentId, "permissions");
    });
  };

  const setContainment = (target: Opened, level: ContainmentLevel) => {
    void setSessionContainment(runtime, target.environmentId, target.sessionId, level, { session: sessionName(), environment: nameFor(target.environmentId) }).then((set) => {
      if (set.ok) setLevels((held) => new Map(held).set(keyOf(target), set.level));
      host.say(set.line);
      if (set.ok) void runtime.setup.check(target.environmentId, "permissions");
    });
  };

  // Settings.

  const writeSetting = (environmentId: string, key: SettingsKey, value: unknown, acknowledged = false) => {
    if (writerOf(key) === null) return;
    if (key === "permissions.unattended.mode" && value === "bypassPermissions" && !acknowledged) {
      return host.ask({
        text: `${BYPASS_SENTENCE} Make bypassPermissions the unattended mode? y/n`,
        yes: () => writeSetting(environmentId, key, value, true),
        no: () => host.say(`${settingLabel(key)} is left as it was.`),
      });
    }
    // The value was checked against the key's schema; `requests.call` checks the params against the method's again.
    void saveSetting(runtime, environmentId, key, value, { commandId: host.newCommandId(), acknowledgeBypass: acknowledged }).then((saved) => {
      if (!saved.ok) return host.say(`Not saved: ${saved.line}`);
      host.change((card) => (card.kind === "settings" && card.environmentId === environmentId ? { ...card, values: { ...card.values, ...saved.values } } : card));
      host.say(`${settingLabel(key)} is ${valueWords(value)}.`);
    });
  };

  const readSettings = (environmentId: string) => {
    void runtime.requests.call(environmentId, "settings.get", {}).then((answer) =>
      host.change((card) =>
        card.kind === "settings" && card.environmentId === environmentId ? (answer.ok ? { ...card, values: answer.result.values } : { ...card, failed: answer.error.message }) : card,
      ),
    );
  };

  const readReview = (environmentId: string) => {
    void runtime.requests.call(environmentId, "permissions.review.list", {}).then((answer) =>
      host.change((card) =>
        card.kind === "review" && card.environmentId === environmentId ? (answer.ok ? { ...card, answer: answer.result } : { ...card, failed: answer.error.message }) : card,
      ),
    );
  };

  // Rows.

  // No row, not even the last, until the accounts are read: the card says it reads them, or why it could not.
  const accountPanelRows = (card: Extract<Panel, { kind: "accounts" }>): readonly PanelRow[] =>
    (accounts?.read().value ?? null) === null
      ? []
      : accountRows(accountList(), card.purpose, { environmentId: card.environmentId, usage: runtime.projections.usage.read(), sessionAccount: sessionAccount() });

  const accountCursor = (card: Extract<Panel, { kind: "accounts" }>): number =>
    card.cursor ?? startingAccount(accountList(), card.purpose === "handoff" ? recommendation?.read().result?.accountId : undefined, sessionAccount());

  const modelList = (card: Extract<Panel, { kind: "models" }>) => modelsOf(models?.read().value ?? [], card.accountId);
  /** The model and effort the session's next run goes out on: its own (#1961), else, from an environment that keeps none, the latest run's. */
  const currentChoice = (): RunChoice | undefined => {
    if (!opened) return undefined;
    const chosen = projection?.summary?.runChoice;
    if (chosen) return chosen;
    const last = projection?.runs.at(-1);
    if (last) return { model: last.model, effort: last.effort };
    const model = projection?.summary?.model;
    return model ? { model, effort: null } : undefined;
  };

  /** The session's mode as the status line says it: the summary's, else the attended default, acceptEdits lowered to the ceiling. */
  const sessionMode = (ceiling: Mode | null): Mode => sessionModeOf(projection?.summary?.mode, ceiling);
  const modeCursor = (card: Extract<Panel, { kind: "modes" }>): number => card.cursor ?? Math.max(0, MODES.indexOf(sessionMode(modes?.read().ceiling ?? null)));

  const containmentView = () => {
    const read = permissions?.read().result;
    const own = projection?.containment ?? (opened ? levels.get(keyOf(opened)) : undefined);
    return { report: read?.containment, own, fallback: read?.values["permissions.containment.default"] };
  };
  const containmentCursor = (card: Extract<Panel, { kind: "containment" }>): number => {
    if (card.cursor !== null) return card.cursor;
    const { own, fallback } = containmentView();
    return Math.max(0, CONTAINMENT_LEVELS.indexOf(own ?? fallback ?? "off"));
  };

  /** The key under the settings card's cursor; none on a row that holds no key. */
  const settingsKey = (card: Extract<Panel, { kind: "settings" }>): SettingsKey | undefined => editorKeys(card.row)[card.cursor];

  const settingsRows = (card: Extract<Panel, { kind: "settings" }>): readonly PanelRow[] => {
    const key = settingsKey(card);
    if (card.edit?.kind === "choice") {
      const form = key === undefined ? undefined : settingForm(key);
      const current = key === undefined ? undefined : card.values?.[key];
      return form?.kind === "choice"
        ? form.options.map((option) => ({ key: String(option), cells: [{ text: valueWords(option) }], dim: false, ...(option === current && { note: { text: "now", dim: true } }) }))
        : [];
    }
    if (card.values === null) return [];
    const listed = editorRows(card.row);
    const width = Math.max(0, ...listed.flatMap((row) => row.keys.map((k) => settingLabel(k).length))) + 2;
    // Each row's label over its first key: the cursor moves over the keys alone.
    return listed.flatMap((row) =>
      row.keys.map((k, at) => ({
        key: k,
        cells: [{ text: settingLabel(k).padEnd(width) }, { text: valueWords(card.values?.[k]) }],
        dim: false,
        ...(at === 0 && { heading: { text: row.label, bold: true } }),
        ...(writerOf(k) === null && { note: { text: "read-only", dim: true } }),
      })),
    );
  };

  const rowsOf = (card: Panel): readonly PanelRow[] => {
    switch (card.kind) {
      case "accounts":
        return accountPanelRows(card);
      case "models": {
        const choice = currentChoice();
        if (card.model !== null) return effortRows(card.model, choice?.model === card.model.id ? choice.effort : undefined);
        return modelRows(modelList(card), choice?.model ?? null);
      }
      case "modes":
        return modes ? modeRows(modes.read(), sessionMode(modes.read().ceiling)) : [];
      case "containment": {
        const { report, own, fallback } = containmentView();
        return containmentRows(report, own, fallback);
      }
      case "setup":
        return setup ? setupRows(setup.read(), runtime.environmentNow(card.environmentId), nameFor(card.environmentId)) : [];
      case "settings":
        return settingsRows(card);
      default:
        return [];
    }
  };

  const cursorOf = (card: Panel): number => {
    switch (card.kind) {
      case "accounts":
        return accountCursor(card);
      case "models":
      case "setup":
      case "settings":
        return card.kind === "settings" && card.edit?.kind === "choice" ? card.edit.cursor : card.cursor;
      case "modes":
        return modeCursor(card);
      case "containment":
        return containmentCursor(card);
      default:
        return 0;
    }
  };

  const withCursor = (card: Panel, cursor: number): Panel => {
    switch (card.kind) {
      case "setup":
        return { ...card, cursor, action: 0 };
      case "accounts":
      case "modes":
      case "containment":
      case "models":
        return { ...card, cursor };
      case "settings":
        return card.edit?.kind === "choice" ? { ...card, edit: { ...card.edit, cursor } } : { ...card, cursor };
      default:
        return card;
    }
  };

  const withEnvironment = (then: (view: EnvironmentView) => void, argument = "") => {
    const named = argument === "" ? undefined : findEnvironment(knownEnvironments(views), argument);
    if (argument !== "" && named === undefined) return host.say(`No environment named ${argument} is known here.`);
    const view = named ?? (opened ? environmentOf(opened.environmentId) : undefined) ?? host.current;
    if (!view || isPlaceholder(view)) return host.say("There is no environment here yet: /pair one first.");
    then(view);
  };

  const selectedStep = (card: Extract<Panel, { kind: "setup" }>) => {
    const steps = setup?.read().steps.filter((step) => step.registered) ?? [];
    return steps[clamp(card.cursor, steps.length)];
  };
  const offered = (card: Extract<Panel, { kind: "setup" }>) => {
    const step = selectedStep(card);
    if (!step?.result) return [];
    const actions = setupActions(step, step.result);
    return step.id === "your-machines" && setup?.read().reach.status === "service-down"
      ? [{ key: "start-service", action: "start-service" as const, words: "Start service", targets: [], plan: { kind: "start-service" as const } }, ...actions.filter((offer) => offer.action !== "start-service")]
      : actions;
  };
  const toolUpdateReason = (card: Extract<Panel, { kind: "setup" }>, offer: OfferedSetupAction): { status: "loading" | "unavailable"; message: string } | undefined => {
    if (offer.action !== "update" || offer.plan.kind !== "run-tool") return undefined;
    const capability = runtime.capability(card.environmentId, "tools.run");
    if (capability.status === "absent") return { status: "unavailable", message: capability.message };
    const listCapability = runtime.capability(card.environmentId, "tools.list");
    if (listCapability.status === "absent") return { status: "unavailable", message: listCapability.message };
    const tools = setupTools?.read();
    if (tools?.error) return { status: "unavailable", message: tools.error.message };
    if (tools?.result === null || tools === undefined) return { status: "loading", message: "Reading managed tools…" };
    const tool = tools.result.tools.find((tool) => offer.plan.kind === "run-tool" && tool.tool === offer.plan.tool);
    // A tool the table cannot drive still updates: in a tool terminal, its vendor's command held back until Enter there (#1833).
    return tool?.action === "update" || tool?.action === "terminal" ? undefined : { status: "unavailable", message: tool?.command ?? "The environment does not serve an update for this tool." };
  };
  const runnableOffers = (card: Extract<Panel, { kind: "setup" }>) => offered(card).filter((offer) => toolUpdateReason(card, offer) === undefined);
  const selectedOffer = (card: Extract<Panel, { kind: "setup" }>) => {
    const offers = runnableOffers(card);
    return offers[clamp(card.action, offers.length)];
  };

  const pickers: Pickers = {
    run(command) {
      switch (command.name) {
        case "account":
          return withEnvironment((view) => host.open({ kind: "accounts", purpose: "account", environmentId: view.environmentId, cursor: null }));
        case "handoff": {
          if (!opened) return host.say("No session is open to hand off: /resume opens one, /new starts one.");
          return withEnvironment((view) => {
            if (view.environmentId !== opened.environmentId) return host.say(`Not handed off to ${nameOf(view)}: ${BETWEEN_ENVIRONMENTS}.`);
            host.open({ kind: "accounts", purpose: "handoff", environmentId: view.environmentId, cursor: null });
          }, command.argument);
        }
        case "model":
          return withEnvironment((view) =>
            host.open({ kind: "models", environmentId: view.environmentId, accountId: opened?.environmentId === view.environmentId ? sessionAccount() : null, cursor: 0, model: null, modelCursor: 0 }),
          );
        case "mode":
          if (!opened) return host.say("No session is open: a mode is a session's. /resume opens one, /new starts one.");
          return host.open({ kind: "modes", environmentId: opened.environmentId, sessionId: opened.sessionId, cursor: null });
        case "containment":
          if (!opened) return host.say("No session is open: containment is a session's. /resume opens one, /new starts one.");
          return host.open({ kind: "containment", environmentId: opened.environmentId, sessionId: opened.sessionId, cursor: null });
        case "usage":
          return host.open({ kind: "usage", top: 0 });
        case "review":
          return withEnvironment((view) => {
            host.open({ kind: "review", environmentId: view.environmentId, top: 0, answer: null, failed: null });
            readReview(view.environmentId);
          });
        case "settings": {
          // ADR 0027: the terminal UI opens its editor by row id, with no rail.
          const row = command.argument === "" ? null : command.argument;
          if (row !== null && !isSettingsRowId(row)) return host.say(noRowLine(row));
          return withEnvironment((view) => {
            host.open({ kind: "settings", environmentId: view.environmentId, row, cursor: 0, values: null, failed: null, edit: null });
            readSettings(view.environmentId);
          });
        }
        case "setup":
          return withEnvironment((view) => {
            const check = ++setupCheck.current;
            host.open({ kind: "setup", environmentId: view.environmentId, cursor: 0, action: 0, sending: false, checking: !view.flags.includes("setup"), failed: null });
            if (view.flags.includes("setup")) return;
            void runtime.setup.check(view.environmentId).then((answer) =>
              host.change((card) =>
                card.kind === "setup" && card.environmentId === view.environmentId && check === setupCheck.current
                  ? { ...card, checking: false, failed: answer.ok ? null : answer.error.message }
                  : card,
              ),
            );
          }, command.argument);
      }
    },

    stepMode() {
      if (!opened) return host.say("No session is open: a mode is a session's. /resume opens one, /new starts one.");
      const picker = runtime.projections.modes(opened.environmentId).read();
      const allowed = picker.modes.filter((m) => m.allowed).map((m) => m.mode);
      if (allowed.length === 0) return host.say("This connection's ceiling is not known yet: no mode can be chosen.");
      const now = asked.current.get(keyOf(opened)) ?? sessionMode(picker.ceiling);
      const next = allowed.find((mode) => compareModes(mode, now) > 0) ?? (allowed[0] as Mode);
      setMode(opened, next);
    },

    rows: (card) => rowsOf(card).length,

    // A value being typed holds its key: the cursor stays on it until the value is saved or left.
    move: (card, step) => (card.kind === "settings" && card.edit?.kind === "text" ? card : withCursor(card, clamp(cursorOf(card) + step, rowsOf(card).length))),

    nextSetupAction(card, direction) {
      if (card.kind !== "setup") return card;
      const count = runnableOffers(card).length;
      return { ...card, action: count === 0 ? 0 : (card.action + direction + count) % count };
    },

    choose(card) {
      switch (card.kind) {
        case "accounts": {
          const list = accountList();
          const at = accountCursor(card);
          const account = list[at];
          if (account) {
            if (account.status.state !== "signed-in") return startSignIn(card.environmentId, account);
            return handOff(card.environmentId, account);
          }
          if (at !== list.length || accountPanelRows(card).length === 0) return;
          if (card.purpose === "handoff") return host.say(`Not handed off: ${BETWEEN_ENVIRONMENTS}.`);
          const absent = lacking(card.environmentId, "accounts.add");
          if (absent !== undefined) return host.say(`Cannot add an account on ${nameFor(card.environmentId)}: ${absent}`);
          return host.open({ kind: "signin", environmentId: card.environmentId, label: "", accountId: null, startedAt: null, sending: null, text: "", error: null });
        }
        case "signin":
          if (card.sending !== null) return;
          if (card.accountId === null) return addAccount(card);
          if (followed(card)?.state === "awaiting-code") return sendCode(card);
          return;
        case "models": {
          if (!opened) return host.say("No session is open: a model rides a session's runs. /resume opens one, /new starts one.");
          const target = opened;
          const choose = (model: ModelEntry, effort: string | null) => {
            host.close();
            void setSessionModel(runtime, target.environmentId, target.sessionId, { model: model.id, effort }, { session: sessionName(), model: model.label }).then(host.say);
          };
          if (card.model !== null) return choose(card.model, card.cursor === 0 ? null : (card.model.efforts[card.cursor - 1] ?? null));
          const model = modelList(card)[card.cursor];
          if (!model) return;
          if (model.efforts.length === 0) return choose(model, null);
          const effort = currentChoice()?.model === model.id ? (currentChoice()?.effort ?? null) : null;
          return host.change((c) => (c.kind === "models" ? { ...c, model, modelCursor: c.cursor, cursor: effort === null ? 0 : model.efforts.indexOf(effort) + 1 } : c));
        }
        case "setup": {
          if (card.sending) return;
          const offer = selectedOffer(card);
          if (!offer) return;
          const generation = setupCheck.current;
          host.change((held) => held.kind === "setup" ? { ...held, sending: true } : held);
          const stillOpen = () => latestPanel.current?.kind === "setup" && latestPanel.current.environmentId === card.environmentId && setupCheck.current === generation;
          void (async () => {
            const { plan } = offer;
            switch (plan.kind) {
              case "start-service":
                return host.startService(card.environmentId);
              case "update":
                return host.say(outcomeWords(await updateEnvironment(runtime, card.environmentId, nameFor(card.environmentId), host.newCommandId())));
              case "restore": {
                const outcome = await restoreStep(runtime, card.environmentId, plan.step, host.newCommandId(), plan.sections);
                host.say(outcomeWords(outcome));
                if (outcome.ok) await runtime.setup.check(card.environmentId, plan.step);
                return;
              }
              case "run-tool": {
                if (offer.action !== "update") break;
                const outcome = await runTool(runtime, card.environmentId, plan.tool, plan.action, runtime.environmentNow(card.environmentId));
                if (outcome.ok && stillOpen()) host.openTool(card.environmentId, outcome.run);
                else if (!outcome.ok) host.say(outcome.line);
                return;
              }
              case "pull-sources":
                return host.say(outcomeWords(await pullSetupSources(runtime, card.environmentId, plan.sources, () => runtime.environmentNow(card.environmentId))));
              case "check": {
                const answer = await runtime.setup.check(card.environmentId, plan.step);
                return host.change((held) => (held.kind === "setup" && held.environmentId === card.environmentId && setupCheck.current === generation ? { ...held, failed: answer.ok ? null : answer.error.message } : held));
              }
            }
            host.say(`${offer.words} runs in the desktop window.`);
          })().catch((error: unknown) => host.say(`Set up action failed: ${oneLine(error instanceof Error ? error.message : String(error))}`)).finally(() => {
            if (stillOpen()) host.change((held) => held.kind === "setup" ? { ...held, sending: false } : held);
          });
          return;
        }
        case "modes": {
          const mode = MODES[modeCursor(card)];
          if (mode === undefined) return;
          host.close();
          return setMode({ environmentId: card.environmentId, sessionId: card.sessionId }, mode);
        }
        case "containment": {
          const level = CONTAINMENT_LEVELS[containmentCursor(card)];
          if (level === undefined) return;
          host.close();
          return setContainment({ environmentId: card.environmentId, sessionId: card.sessionId }, level);
        }
        case "settings": {
          const key = settingsKey(card);
          if (card.values === null || key === undefined) return;
          const absent = lacking(card.environmentId, "settings.update");
          if (absent !== undefined) return host.say(`Not changed: ${absent}`);
          if (writerOf(key) === null) return host.say(`${settingLabel(key)} is recorded by the environment itself; nothing sets it.`);
          const form = settingForm(key);
          if (card.edit?.kind === "choice") {
            const value = form.kind === "choice" ? form.options[card.edit.cursor] : undefined;
            host.change((c) => (c.kind === "settings" ? { ...c, edit: null } : c));
            return value === undefined ? undefined : writeSetting(card.environmentId, key, value);
          }
          if (card.edit?.kind === "text") {
            const parsed = parseTyped(key, card.edit.text);
            if (!parsed.ok) return host.change((c) => (c.kind === "settings" && c.edit?.kind === "text" ? { ...c, edit: { ...c.edit, error: `Not saved: ${parsed.line}` } } : c));
            host.change((c) => (c.kind === "settings" ? { ...c, edit: null } : c));
            return writeSetting(card.environmentId, key, parsed.value);
          }
          if (form.kind === "switch") return writeSetting(card.environmentId, key, card.values[key] !== true);
          if (form.kind === "choice") return host.change((c) => (c.kind === "settings" ? { ...c, edit: { kind: "choice", cursor: Math.max(0, form.options.indexOf(card.values?.[key] as never)) } } : c));
          return host.change((c) => (c.kind === "settings" ? { ...c, edit: { kind: "text", text: "", error: null } } : c));
        }
        default:
          return;
      }
    },

    back(card) {
      switch (card.kind) {
        case "signin":
          // A command on its way has the card until it answers.
          if (card.sending !== null) return card;
          if (card.text !== "") return { ...card, text: "", error: null };
          if (card.accountId === null) return { kind: "accounts", purpose: "account", environmentId: card.environmentId, cursor: null };
          // The sign-in this card started is the card's to end: leaving it cancels it, whatever state it has reached.
          cancelSignIn(card);
          return null;
        case "models":
          return card.model !== null ? { ...card, model: null, cursor: card.modelCursor } : null;
        case "settings":
          return card.edit !== null ? { ...card, edit: null } : null;
        default:
          return null;
      }
    },

    takesText(card) {
      if (card.kind === "settings") return card.edit?.kind === "text";
      if (card.kind !== "signin" || card.sending !== null) return false;
      return card.accountId === null || followed(card)?.state === "awaiting-code";
    },

    typed(card, text) {
      const clean = text.replace(/[\r\n]/g, "");
      if (card.kind === "signin") return { ...card, text: card.text + clean, error: null };
      if (card.kind === "settings" && card.edit?.kind === "text") return { ...card, edit: { ...card.edit, text: card.edit.text + clean, error: null } };
      return card;
    },

    erased(card) {
      const drop = (text: string) => [...text].slice(0, -1).join("");
      if (card.kind === "signin") return { ...card, text: drop(card.text) };
      if (card.kind === "settings" && card.edit?.kind === "text") return { ...card, edit: { ...card.edit, text: drop(card.edit.text) } };
      return card;
    },

    isLines: (card) => card.kind === "usage" || card.kind === "review",

    scroll(card, to) {
      if (card.kind !== "usage" && card.kind !== "review") return card;
      const most = Math.max(0, drawn.current.lines - drawn.current.height);
      return { ...card, top: Math.min(Math.max(to(Math.min(card.top, most)), 0), most) };
    },

    hint(card) {
      const k = host.keys;
      const list = (verb: string, leave: string) => `${k("picker.move")} move · ${k("picker.choose")} ${verb} · ${k("picker.leave")} ${leave}`;
      switch (card.kind) {
        case "accounts":
          return list(card.purpose === "handoff" ? "hands off or signs in" : "hands off, signs in or adds", "close");
        case "signin":
          return card.accountId === null ? `${k("picker.choose")} adds it · ${k("picker.leave")} goes back` : `${k("picker.choose")} sends the code · ${k("picker.leave")} cancels the sign-in`;
        case "models":
          return list("chooses", card.model !== null ? "back" : "close");
        case "modes":
        case "containment":
          return list("sets", "close");
        case "setup":
          return `${list("runs the action", "close")} · ${k("picker.preview")} next action`;
        case "usage":
        case "review":
          return `${k("pager.line")} ${k("pager.halfDown")} ${k("pager.halfUp")} scroll · ${k("pager.close")} close`;
        case "settings":
          if (card.edit?.kind === "text") return `${k("picker.choose")} saves · ${k("picker.leave")} leaves it`;
          return card.edit?.kind === "choice" ? list("picks", "back") : list("changes", "close");
      }
    },

    render(card, size) {
      const hint = pickers.hint(card);
      const rows = rowsOf(card);
      const cursor = clamp(cursorOf(card), rows.length);
      const text = (spans: readonly Span[]): Line[] => wrap(spans, Math.max(10, size.width - 1)).map((line) => ({ row: "", spans: line }));
      switch (card.kind) {
        case "accounts": {
          const recommended = card.purpose === "handoff" ? recommendation?.read().result : undefined;
          const loaded = accounts?.read();
          return (
            <ListCard
              width={size.width}
              title={card.purpose === "handoff" ? `Hand off ${sessionName()} on ${nameFor(card.environmentId)}` : `Accounts on ${nameFor(card.environmentId)}`}
              hint={hint}
              rows={rows}
              cursor={cursor}
              height={size.height}
              empty={loaded?.error ? `The accounts could not be read: ${loaded.error.message}` : "Reading the accounts…"}
              footer={recommended ? [[{ text: recommended.message, color: TERMINAL_ROLES.warning }]] : []}
            />
          );
        }
        case "signin": {
          const name = nameFor(card.environmentId);
          const held = followed(card);
          const directory = accountList().find((a) => a.id === card.accountId)?.directory.path;
          const lines: (readonly Span[])[] = [];
          if (card.accountId === null && card.sending === null) {
            return (
              <LinesPanel title={`Add an account on ${name}`} hint={hint} lines={[[{ text: "The email it signs in as makes a good label.", dim: true }], ...(card.error ? [[{ text: card.error, color: TERMINAL_ROLES.danger }]] : [])]}>
                <TypedLine prompt="Label for the new account:" text={card.text} />
              </LinesPanel>
            );
          }
          // The page stays in sight while a code is checked, so another code can follow a refused one.
          if (held?.url != null && (held.state === "awaiting-code" || held.state === "submitting" || card.sending === "code")) {
            lines.push([{ text: "Open this page and sign in:" }], [{ text: held.url, color: TERMINAL_ROLES.machine }], []);
          }
          if (card.sending === "code" || held?.state === "submitting") lines.push([{ text: "Checking the code…", dim: true }]);
          else if (!held || held.state === "starting" || card.sending !== null) lines.push([{ text: "Starting the sign-in…", dim: true }]);
          const typing = held?.state === "awaiting-code" && card.sending === null;
          const after: (readonly Span[])[] = [
            ...(card.error ? [[{ text: card.error, color: TERMINAL_ROLES.danger }]] : []),
            ...(held ? [[], [{ text: `Or run this in a terminal on ${name}'s machine:`, dim: true }], [{ text: fallbackOf(held, directory) }]] : []),
          ];
          return (
            <LinesPanel title={`Sign in: ${card.label} on ${name}`} hint={hint} lines={lines} after={after}>
              {typing && <TypedLine prompt="Then paste the code it shows:" text={card.text} />}
            </LinesPanel>
          );
        }
        case "models": {
          const label = card.accountId !== null ? (accountList().find((a) => a.id === card.accountId)?.label ?? card.accountId) : undefined;
          const loaded = models?.read();
          return (
            <ListCard
              width={size.width}
              title={card.model !== null ? `Effort for ${modelDisplayName(card.model.id, card.model.label)}` : `Models${label !== undefined ? ` for ${label}` : ""} on ${nameFor(card.environmentId)}`}
              hint={hint}
              rows={rows}
              cursor={cursor}
              height={size.height}
              empty={loaded?.error ? `The models could not be read: ${loaded.error.message}` : loaded?.value === null ? "Reading the models…" : "No model is listed for this account."}
            />
          );
        }
        case "modes": {
          const sentence = modeFooter(MODES[cursor]);
          return (
            <ListCard width={size.width} title={`Mode of ${sessionName()}`} hint={hint} rows={rows} cursor={cursor} height={size.height} footer={sentence !== undefined ? [[{ text: sentence, color: TERMINAL_ROLES.danger }]] : []} />
          );
        }
        case "containment": {
          const read = permissions?.read();
          return (
            <ListCard
              width={size.width}
              title={`Containment of ${sessionName()}`}
              hint={hint}
              rows={rows}
              cursor={cursor}
              height={size.height}
              footer={read?.error ? [[{ text: `What ${nameFor(card.environmentId)} can enforce could not be read: ${read.error.message}`, color: TERMINAL_ROLES.warning }]] : []}
            />
          );
        }
        case "usage": {
          const lines = usageLines(runtime.projections.usage.read(), views, (id) => runtime.projections.accounts(id).read(), meterCells(size.width), host.clock.now()).flatMap(text);
          drawn.current = { lines: lines.length, height: size.height };
          return <LinesCard title="Plan usage, pooled by account identity" hint={hint} lines={lines} top={Math.min(card.top, Math.max(0, lines.length - size.height))} height={size.height} />;
        }
        case "setup": {
          const footer = setup ? setupLines(setup.read(), nameFor(card.environmentId), card.checking, card.failed, liveSetup) : [];
          const offer = selectedOffer(card);
          const step = selectedStep(card);
          const blockedOffers = offered(card).flatMap((offer) => {
            const reason = toolUpdateReason(card, offer);
            return reason === undefined ? [] : [{ offer, reason }];
          });
          const loadingTools = blockedOffers.some(({ reason }) => reason.status === "loading");
          const reasons = blockedOffers.map(({ offer, reason }) => [{
            text: reason.status === "loading" ? reason.message : `Update ${offer.targets[0]?.label ?? "tool"} is unavailable here: ${reason.message}`,
            dim: true,
          }]);
          return (
            <ListCard
              title={`Set up on ${nameFor(card.environmentId)}`} hint={hint} rows={rows}
              cursor={clamp(card.cursor, rows.length)} height={size.height} width={size.width}
              footer={[
                ...footer,
                ...(step ? [[{ text: setupStepWords(step, runtime.environmentNow(card.environmentId), nameFor(card.environmentId)), dim: true }]] : []),
                ...reasons,
                [{ text: card.sending ? "Running the action…" : offer ? `Action: ${offer.words}` : loadingTools ? "Waiting for managed tools before offering Update." : "No action offered.", dim: true }],
              ]}
            />
          );
        }
        case "review": {
          const titleOf = (sessionId: string) => runtime.projections.sessionList.read().rows.find((row) => row.environmentId === card.environmentId && row.summary.id === sessionId)?.summary.title;
          const lines = (
            card.answer ? reviewLines(card.answer, titleOf) : [[{ text: card.failed !== null ? `The review could not be read: ${card.failed}` : "Reading the review…", dim: true }]]
          ).flatMap(text);
          drawn.current = { lines: lines.length, height: size.height };
          return <LinesCard title={`To review on ${nameFor(card.environmentId)}`} hint={hint} lines={lines} top={Math.min(card.top, Math.max(0, lines.length - size.height))} height={size.height} />;
        }
        case "settings": {
          const key = settingsKey(card);
          const absent = lacking(card.environmentId, "settings.update");
          const typedPrompt = key === undefined ? "" : `New value for ${settingLabel(key)} (now ${valueWords(card.values?.[key])}), as JSON or a bare word:`;
          const footer: (readonly Span[])[] =
            card.edit?.kind === "text"
              ? [...(card.edit.error !== null ? [[{ text: card.edit.error, color: TERMINAL_ROLES.danger }]] : [])]
              : card.values !== null && card.edit === null && key !== undefined
                ? [[{ text: describeKey(key), dim: true }]]
                : [];
          return (
            <ListCard
              width={size.width}
              title={card.edit?.kind === "choice" && key !== undefined ? `${settingLabel(key)}:` : `Settings on ${nameFor(card.environmentId)}`}
              {...(absent !== undefined && card.edit === null && { lead: [{ text: `read-only: ${absent}`, color: TERMINAL_ROLES.warning }] })}
              hint={hint}
              rows={card.edit?.kind === "text" ? rows.filter((_, at) => at === card.cursor) : rows}
              cursor={card.edit?.kind === "text" ? 0 : cursor}
              height={size.height}
              {...(card.edit?.kind === "text" && { childRows: wrappedRows(`${typedPrompt} ${card.edit.text} `, size.width) })}
              empty={
                card.row !== null && editorKeys(card.row).length === 0
                  ? noKeysLine(card.row)
                  : card.failed !== null
                    ? `The settings could not be read: ${card.failed}`
                    : "Reading the settings…"
              }
              footer={footer}
            >
              {card.edit?.kind === "text" && <TypedLine prompt={typedPrompt} text={card.edit.text} />}
            </ListCard>
          );
        }
      }
    },

    containment: (target) => (target ? levels.get(keyOf(target)) : undefined),
    forkedOnto: (target) => (target ? forks.get(keyOf(target)) : undefined),
  };
  return pickers;
};
