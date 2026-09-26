import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import type { EnvironmentView, RequestAnswer, Runtime, SessionProjection } from "@agent-harness/client-runtime";
import {
  AccountLabel,
  BYPASS_SENTENCE,
  MODES,
  compareModes,
  lowerMode,
  settingForm,
  type AccountRecord,
  type CommandMethodName,
  type CommandReceipt,
  type ContainmentLevel,
  type KeyActionId,
  type Mode,
  type ParamsOf,
  type ResultOf,
  type SettingsKey,
} from "@agent-harness/contracts";
import { LinesCard } from "../screens/transcript.js";
import type { Opened } from "../session/use-session.js";
import { useFollow } from "../session/use-session.js";
import { meterCells } from "../status/line.js";
import type { RunChoice } from "../status/use-status.js";
import { wrap, type Line, type Span } from "../transcript/lines.js";
import { findEnvironment, isPlaceholder, knownEnvironments, nameOf } from "../view.js";
import { ListCard, LinesPanel, TypedLine, wrappedRows } from "./cards.js";
import type { PickerCommand } from "./commands.js";
import {
  BETWEEN_ENVIRONMENTS,
  accountRows,
  containmentRows,
  effortRows,
  fallbackOf,
  modeFooter,
  modeRows,
  modelRows,
  modelsOf,
  reviewLines,
  signInEnd,
  startingAccount,
  usageLines,
  type Panel,
  type PanelRow,
} from "./panel.js";
import { EDITOR_KEYS, describeKey, parseTyped, valueWords, writerOf } from "./settings.js";

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
  ask(question: { readonly text: string; readonly yes: () => void; readonly no?: () => void }): void;
  openSession(opened: Opened): void;
  newCommandId(): string;
  newSessionId(): string;
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
  /** The model and effort this terminal chose for the session's next runs. */
  choice(opened: Opened | null): RunChoice | undefined;
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
  const { runtime, request, panel, opened, projection, views } = host;
  const [choices, setChoices] = useState<ReadonlyMap<string, RunChoice>>(new Map());
  const [levels, setLevels] = useState<ReadonlyMap<string, ContainmentLevel>>(new Map());
  const [forks, setForks] = useState<ReadonlyMap<string, string>>(new Map());
  // The lines a card of lines drew last: what its scroll is clamped to.
  const drawn = useRef({ lines: 0, height: 1 });

  const environmentOf = (environmentId: string): EnvironmentView | undefined => views.find((v) => v.environmentId === environmentId);
  const nameFor = (environmentId: string): string => {
    const view = environmentOf(environmentId);
    return view ? nameOf(view) : "the environment";
  };
  const sessionName = (): string => projection?.summary?.title ?? "this session";
  const sessionAccount = (): string | null => projection?.summary?.accountId ?? (opened ? (forks.get(keyOf(opened)) ?? null) : null);

  // What the open card shows, followed while it is open.
  const kind = panel?.kind;
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

  /** The sign-in the card follows: its account's, from when the card started it on. */
  const followed = (card: Extract<Panel, { kind: "signin" }>) => {
    const held = signIn?.read().result?.signIn;
    // Until the start answers, the sign-in the card started is not known from an earlier one of the account.
    if (!held || card.accountId === null || card.sending === "start" || held.accountId !== card.accountId) return undefined;
    if (card.startedAt !== null && Date.parse(held.startedAt) < Date.parse(card.startedAt)) return undefined;
    return held;
  };

  // A sign-in this card follows that ends closes it, and its end is said in one line.
  const followedNow = panel?.kind === "signin" ? followed(panel) : undefined;
  const ending = panel?.kind === "signin" && followedNow ? signInEnd(followedNow, panel.label, nameFor(panel.environmentId)) : undefined;
  useEffect(() => {
    if (ending === undefined) return;
    host.close(isSignIn);
    host.say(ending);
  }, [ending]);

  /** An `admin` command as a direct request: its result (none from a retry answered by its stored receipt), or the line saying why not. */
  const admin = async <N extends CommandMethodName>(
    call: () => Promise<RequestAnswer<N>>,
  ): Promise<{ readonly ok: true; readonly result: ResultOf<N> | undefined } | { readonly ok: false; readonly line: string }> => {
    const answer = await call();
    if (!answer.ok) return { ok: false, line: answer.error.message };
    const { receipt, result } = answer.result as { readonly receipt: CommandReceipt; readonly result?: ResultOf<N> };
    if (receipt.status === "rejected") return { ok: false, line: receipt.error.message };
    return { ok: true, result };
  };

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
    void admin(() => runtime.requests.call(environmentId, "accounts.signin.start", { commandId: host.newCommandId(), accountId: account.id })).then((answer) => {
      if (!answer.ok) {
        host.close(isSignIn);
        return host.say(`${account.label} was not signed in: ${answer.line}`);
      }
      host.change((card) => (card.kind === "signin" && card.accountId === account.id ? { ...card, sending: null, startedAt: answer.result?.signIn.startedAt ?? null } : card));
    });
  };

  const addAccount = (card: Extract<Panel, { kind: "signin" }>) => {
    const label = card.text.trim();
    if (!AccountLabel.safeParse(label).success) {
      return host.change((c) => (c.kind === "signin" ? { ...c, error: "A label is one line of up to 200 characters, with no space at either end." } : c));
    }
    host.change((c) => (c.kind === "signin" ? { ...c, label, sending: "add", error: null } : c));
    void admin(() => runtime.requests.call(card.environmentId, "accounts.add", { commandId: host.newCommandId(), label })).then((answer) => {
      if (!answer.ok) return host.change((c) => (c.kind === "signin" ? { ...c, sending: null, error: `Not added: ${answer.line}` } : c));
      const result = answer.result;
      if (!result) {
        host.close(isSignIn);
        return host.say(`${label} was added on ${nameFor(card.environmentId)}; /account shows it.`);
      }
      if (!result.signIn.started) {
        host.close(isSignIn);
        return host.say(`${label} was added on ${nameFor(card.environmentId)}, but its sign-in did not start: ${result.signIn.message ?? "the environment gave no reason"}`);
      }
      host.change((c) => (c.kind === "signin" ? { ...c, accountId: result.account.id, sending: null, text: "" } : c));
    });
  };

  const sendCode = (card: Extract<Panel, { kind: "signin" }>) => {
    const code = card.text.trim();
    if (code === "" || card.accountId === null) return;
    host.change((c) => (c.kind === "signin" ? { ...c, sending: "code", error: null } : c));
    void admin(() => runtime.requests.call(card.environmentId, "accounts.signin.code", { commandId: host.newCommandId(), accountId: card.accountId as string, code })).then((answer) =>
      host.change((c) => (c.kind === "signin" ? { ...c, sending: null, ...(answer.ok ? { text: "" } : { error: `The code was not taken: ${answer.line}` }) } : c)),
    );
  };

  const cancelSignIn = (card: Extract<Panel, { kind: "signin" }>) => {
    if (card.accountId === null) return;
    const name = nameFor(card.environmentId);
    void admin(() => runtime.requests.call(card.environmentId, "accounts.signin.cancel", { commandId: host.newCommandId(), accountId: card.accountId as string })).then((answer) => {
      if (!answer.ok) return host.say(`The sign-in of ${card.label} was not cancelled: ${answer.line}`);
      const ended = answer.result ? signInEnd(answer.result.signIn, card.label, name) : undefined;
      host.say(ended ?? `The sign-in of ${card.label} was cancelled.`);
    });
  };

  // Hand-off and the session's own settings.

  const handOff = (environmentId: string, account: AccountRecord) => {
    if (!opened) return host.say("No session is open to hand off: /resume opens one, /new starts one, and its account is chosen as it starts.");
    if (environmentId !== opened.environmentId) return host.say(`Not handed off to ${nameFor(environmentId)}: ${BETWEEN_ENVIRONMENTS}.`);
    const sessionId = opened.sessionId;
    const from = sessionName();
    if (account.id === sessionAccount()) return host.say(`${from} runs on ${account.label} already.`);
    const id = host.newSessionId();
    host.close();
    host.say(`Handing ${from} off to ${account.label}…`);
    // A session cannot change its account (runs.start takes none): the hand-off onto another account is a fork on it (sessions.fork).
    void runtime.commands.dispatch(environmentId, "sessions.fork", { sessionId, id, account: account.id }).then((answer) => {
      if (!answer.ok) return host.say(`Not handed off: ${answer.error.message}`);
      setForks((held) => new Map(held).set(keyOf({ environmentId, sessionId: id }), account.id));
      host.openSession({ environmentId, sessionId: id });
      host.say(`Handed off to ${account.label}: a new session forked from ${from} runs on it; ${from} stays as it is.`);
    });
  };

  const setMode = (target: Opened, mode: Mode) => {
    const name = sessionName();
    void runtime.commands.dispatch(target.environmentId, "permissions.mode.set", { sessionId: target.sessionId, mode }).then((answer) => {
      if (!answer.ok) return host.say(`The mode was not set: ${answer.error.message}`);
      const resolved = answer.result?.mode;
      if (!resolved) return host.say(`Mode: ${mode}.`);
      const live = answer.result?.live ? " The running turn has it too." : "";
      if (!resolved.clamped) return host.say(`Mode: ${resolved.effective}.${resolved.effective === "bypassPermissions" ? ` ${BYPASS_SENTENCE}` : ""}${live}`);
      const why = resolved.clampReason === "unavailable" ? `its account cannot use ${resolved.requested}` : `clamped to this connection's ceiling (${resolved.ceiling})`;
      host.say(`Asked for ${resolved.requested}; ${name} has ${resolved.effective}: ${why}.${live}`);
    });
  };

  const setContainment = (target: Opened, level: ContainmentLevel) => {
    const name = sessionName();
    void runtime.commands.dispatch(target.environmentId, "permissions.containment.set", { sessionId: target.sessionId, level }).then((answer) => {
      if (!answer.ok) {
        const reason = answer.error.code === "containment_unavailable" && typeof answer.error.data?.["reason"] === "string" ? answer.error.data["reason"] : answer.error.message;
        return host.say(answer.error.code === "containment_unavailable" ? `${level} cannot be enforced on ${nameFor(target.environmentId)}: ${reason}` : `Containment was not set: ${reason}`);
      }
      const effective = answer.result?.containment.effective ?? level;
      setLevels((held) => new Map(held).set(keyOf(target), effective));
      host.say(`Containment: ${effective}, from the next run of ${name}.`);
    });
  };

  // Settings.

  const writeSetting = (environmentId: string, key: SettingsKey, value: unknown, acknowledged = false) => {
    const writer = writerOf(key);
    if (writer === null) return;
    if (key === "permissions.unattended.mode" && value === "bypassPermissions" && !acknowledged) {
      return host.ask({
        text: `${BYPASS_SENTENCE} Make bypassPermissions the unattended mode? y/n`,
        yes: () => writeSetting(environmentId, key, value, true),
        no: () => host.say(`${key} is left as it was.`),
      });
    }
    const commandId = host.newCommandId();
    // The value was checked against the key's schema; `requests.call` checks the params against the method's again.
    const values = { [key]: value };
    const saved = (answer: { readonly ok: true; readonly result: { readonly values: Readonly<Record<string, unknown>> } | undefined } | { readonly ok: false; readonly line: string }) => {
      if (!answer.ok) return host.say(`Not saved: ${answer.line}`);
      host.change((card) => (card.kind === "settings" && card.environmentId === environmentId ? { ...card, values: { ...card.values, ...(answer.result?.values ?? values) } } : card));
      host.say(`${key} is ${valueWords(value)}.`);
    };
    if (writer === "settings.update") {
      void admin(() => runtime.requests.call(environmentId, "settings.update", { commandId, values: values as ParamsOf<"settings.update">["values"] })).then(saved);
      return;
    }
    void admin(() =>
      runtime.requests.call(environmentId, "permissions.settings.set", {
        commandId,
        values: values as ParamsOf<"permissions.settings.set">["values"],
        ...(acknowledged && { acknowledgeBypass: true as const }),
      }),
    ).then(saved);
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
  const currentChoice = (): RunChoice | undefined => {
    if (!opened) return undefined;
    const chosen = choices.get(keyOf(opened));
    if (chosen) return chosen;
    const last = projection?.runs.at(-1);
    if (last) return { model: last.model, effort: last.effort };
    const model = projection?.summary?.model;
    return model ? { model, effort: null } : undefined;
  };

  const modeCursor = (card: Extract<Panel, { kind: "modes" }>): number => card.cursor ?? Math.max(0, MODES.indexOf(projection?.summary?.mode ?? "acceptEdits"));

  const containmentView = () => {
    const read = permissions?.read().result;
    const own = opened ? levels.get(keyOf(opened)) : undefined;
    return { report: read?.containment, own, fallback: read?.values["permissions.containment.default"] };
  };
  const containmentCursor = (card: Extract<Panel, { kind: "containment" }>): number => {
    if (card.cursor !== null) return card.cursor;
    const { own, fallback } = containmentView();
    return Math.max(0, (["off", "workspace", "workspace-no-network"] as const).indexOf(own ?? fallback ?? "off"));
  };

  const settingsRows = (card: Extract<Panel, { kind: "settings" }>): readonly PanelRow[] => {
    if (card.edit?.kind === "choice") {
      const form = settingForm(EDITOR_KEYS[card.cursor] as SettingsKey);
      const current = card.values?.[EDITOR_KEYS[card.cursor] as string];
      return form.kind === "choice"
        ? form.options.map((option) => ({ key: String(option), cells: [{ text: valueWords(option) }], dim: false, ...(option === current && { note: { text: "now", dim: true } }) }))
        : [];
    }
    if (card.values === null) return [];
    const width = Math.max(...EDITOR_KEYS.map((k) => k.length)) + 2;
    return EDITOR_KEYS.map((key) => ({
      key,
      cells: [{ text: key.padEnd(width) }, { text: valueWords(card.values?.[key]) }],
      dim: false,
      ...(writerOf(key) === null && { note: { text: "read-only", dim: true } }),
    }));
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
        return modes ? modeRows(modes.read(), projection?.summary?.mode ?? null) : [];
      case "containment": {
        const { report, own, fallback } = containmentView();
        return containmentRows(report, own, fallback);
      }
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
        case "settings":
          return withEnvironment((view) => {
            host.open({ kind: "settings", environmentId: view.environmentId, cursor: 0, values: null, failed: null, edit: null });
            readSettings(view.environmentId);
          });
        case "setup":
          // ADR 0031: a step's health is `setup.check`'s to run and the `setup` subscription's to carry; neither is on the wire yet (#88).
          return withEnvironment(
            (view) =>
              host.say(
                `Set up on ${nameOf(view)} cannot be read from here yet: no step-registry query is on the wire (setup.check and the setup subscription, ADR 0031). Run it in the desktop window.`,
              ),
            command.argument,
          );
      }
    },

    stepMode() {
      if (!opened) return host.say("No session is open: a mode is a session's. /resume opens one, /new starts one.");
      const picker = runtime.projections.modes(opened.environmentId).read();
      const allowed = picker.modes.filter((m) => m.allowed).map((m) => m.mode);
      if (allowed.length === 0) return host.say("This connection's ceiling is not known yet: no mode can be chosen.");
      const now = projection?.summary?.mode ?? lowerMode("acceptEdits", picker.ceiling ?? "acceptEdits");
      const next = allowed.find((mode) => compareModes(mode, now) > 0) ?? (allowed[0] as Mode);
      setMode(opened, next);
    },

    rows: (card) => rowsOf(card).length,

    // A value being typed holds its key: the cursor stays on it until the value is saved or left.
    move: (card, step) => (card.kind === "settings" && card.edit?.kind === "text" ? card : withCursor(card, clamp(cursorOf(card) + step, rowsOf(card).length))),

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
          const choose = (model: string, effort: string | null) => {
            setChoices((held) => new Map(held).set(keyOf(target), { model, effort }));
            host.close();
            host.say(`The next run of ${sessionName()} goes out on ${model} at ${effort === null ? "its own effort" : `${effort} effort`}.`);
          };
          if (card.model !== null) return choose(card.model.id, card.cursor === 0 ? null : (card.model.efforts[card.cursor - 1] ?? null));
          const model = modelList(card)[card.cursor];
          if (!model) return;
          if (model.efforts.length === 0) return choose(model.id, null);
          const effort = currentChoice()?.model === model.id ? (currentChoice()?.effort ?? null) : null;
          return host.change((c) => (c.kind === "models" ? { ...c, model, modelCursor: c.cursor, cursor: effort === null ? 0 : model.efforts.indexOf(effort) + 1 } : c));
        }
        case "modes": {
          const mode = MODES[modeCursor(card)];
          if (mode === undefined) return;
          host.close();
          return setMode({ environmentId: card.environmentId, sessionId: card.sessionId }, mode);
        }
        case "containment": {
          const level = (["off", "workspace", "workspace-no-network"] as const)[containmentCursor(card)];
          if (level === undefined) return;
          host.close();
          return setContainment({ environmentId: card.environmentId, sessionId: card.sessionId }, level);
        }
        case "settings": {
          if (card.values === null) return;
          const key = EDITOR_KEYS[card.cursor] as SettingsKey;
          const absent = lacking(card.environmentId, "settings.update");
          if (absent !== undefined) return host.say(`Not changed: ${absent}`);
          if (writerOf(key) === null) return host.say(`${key} is recorded by the environment itself; nothing sets it.`);
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
          return list(card.purpose === "handoff" ? "hands off" : "hands off, signs in or adds", "close");
        case "signin":
          return card.accountId === null ? `${k("picker.choose")} adds it · ${k("picker.leave")} goes back` : `${k("picker.choose")} sends the code · ${k("picker.leave")} cancels the sign-in`;
        case "models":
          return list("chooses", card.model !== null ? "back" : "close");
        case "modes":
        case "containment":
          return list("sets", "close");
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
              footer={recommended ? [[{ text: recommended.message, color: "yellow" }]] : []}
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
              <LinesPanel title={`Add an account on ${name}`} hint={hint} lines={[[{ text: "The email it signs in as makes a good label.", dim: true }], ...(card.error ? [[{ text: card.error, color: "red" }]] : [])]}>
                <TypedLine prompt="Label for the new account:" text={card.text} />
              </LinesPanel>
            );
          }
          // The page stays in sight while a code is checked, so another code can follow a refused one.
          if (held?.url != null && (held.state === "awaiting-code" || held.state === "submitting" || card.sending === "code")) {
            lines.push([{ text: "Open this page and sign in:" }], [{ text: held.url, color: "cyan" }], []);
          }
          if (card.sending === "code" || held?.state === "submitting") lines.push([{ text: "Checking the code…", dim: true }]);
          else if (!held || held.state === "starting" || card.sending !== null) lines.push([{ text: "Starting the sign-in…", dim: true }]);
          const typing = held?.state === "awaiting-code" && card.sending === null;
          const after: (readonly Span[])[] = [
            ...(card.error ? [[{ text: card.error, color: "red" }]] : []),
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
              title={card.model !== null ? `Effort for ${card.model.label ?? card.model.id}` : `Models${label !== undefined ? ` for ${label}` : ""} on ${nameFor(card.environmentId)}`}
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
            <ListCard width={size.width} title={`Mode of ${sessionName()}`} hint={hint} rows={rows} cursor={cursor} height={size.height} footer={sentence !== undefined ? [[{ text: sentence, color: "red" }]] : []} />
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
              footer={read?.error ? [[{ text: `What ${nameFor(card.environmentId)} can enforce could not be read: ${read.error.message}`, color: "yellow" }]] : []}
            />
          );
        }
        case "usage": {
          const lines = usageLines(runtime.projections.usage.read(), views, (id) => runtime.projections.accounts(id).read(), meterCells(size.width)).flatMap(text);
          drawn.current = { lines: lines.length, height: size.height };
          return <LinesCard title="Plan usage, pooled by account identity" hint={hint} lines={lines} top={Math.min(card.top, Math.max(0, lines.length - size.height))} height={size.height} />;
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
          const key = EDITOR_KEYS[card.cursor] as SettingsKey;
          const absent = lacking(card.environmentId, "settings.update");
          const typedPrompt = (edited: SettingsKey) => `New value for ${edited} (now ${valueWords(card.values?.[edited])}), as JSON or a bare word:`;
          const footer: (readonly Span[])[] =
            card.edit?.kind === "text"
              ? [...(card.edit.error !== null ? [[{ text: card.edit.error, color: "red" }]] : [])]
              : card.values !== null && card.edit === null
                ? [[{ text: describeKey(key), dim: true }]]
                : [];
          return (
            <ListCard
              width={size.width}
              title={card.edit?.kind === "choice" ? `${key}:` : `Settings on ${nameFor(card.environmentId)}`}
              {...(absent !== undefined && card.edit === null && { lead: [{ text: `read-only: ${absent}`, color: "yellow" }] })}
              hint={hint}
              rows={card.edit?.kind === "text" ? rows.filter((_, at) => at === card.cursor) : rows}
              cursor={card.edit?.kind === "text" ? 0 : cursor}
              height={size.height}
              {...(card.edit?.kind === "text" && { childRows: wrappedRows(`${typedPrompt(key)} ${card.edit.text} `, size.width) })}
              empty={card.failed !== null ? `The settings could not be read: ${card.failed}` : "Reading the settings…"}
              footer={footer}
            >
              {card.edit?.kind === "text" && <TypedLine prompt={typedPrompt(key)} text={card.edit.text} />}
            </ListCard>
          );
        }
      }
    },

    choice: (target) => (target ? choices.get(keyOf(target)) : undefined),
    containment: (target) => (target ? levels.get(keyOf(target)) : undefined),
    forkedOnto: (target) => (target ? forks.get(keyOf(target)) : undefined),
  };
  return pickers;
};
