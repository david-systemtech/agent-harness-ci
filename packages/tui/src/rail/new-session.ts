import { ACCOUNT_STATUS_WORDS, identityWords, modelDisplayName, modelName, requestLabel, type EnvironmentView, type NewSessionChips, type NewSessionFocus, type NewSessionView, type Observable } from "@agent-harness/client-runtime";
import type { AccountRecord, ModelEntry } from "@agent-harness/contracts";
import { nameOf } from "../view.js";
import { browserPicker } from "./browser.js";
import { pickerOf, type Chip, type Picker, type PickerRow } from "./picker.js";
import { withBadge, type RailActs } from "./pickers.js";
import { environmentChip, requestWords, sendFromStep, workspaceStep, type StepPlace } from "./workspace-step.js";

/**
 * The new-session card (workspace-picker spec, "The picker in the client
 * runtime" and "Renderers"; ADR 0005; docs/specs/tui.md, "Starting a
 * session"; #334): Enter on an environment's heading, `/new` with no session
 * open and `/cwd` open it. Its chips are `projections.newSession`'s presets
 * for what is in focus, drawn as they arrive: environment, account, model,
 * then workspace. The card is the workspace step (`workspace-step.ts`) under
 * those chips, with a row for each of the first three to change it: another
 * environment (an unusable one greyed with its reason), after which the
 * chips after it follow the new presets, keeping what the projection keeps;
 * another account; another model. The workspace chosen starts the session
 * through `commands.startSession` under an id minted when the card opens,
 * which a new worktree branch's preset name shows; accepted, the rail's
 * cursor goes to the new session's row, and `/new` opens it.
 */

/** What the card is opened on, and what follows its session's start. */
export interface CardOpening {
  /** What the rail or the composer has in focus: an environment's heading (or `--environment`), the open session, or nothing. */
  readonly focus: NewSessionFocus;
  /** The chips already set: a changed one, or `/new`'s workspace, the terminal's own directory on the local environment. */
  readonly chips?: NewSessionChips;
  /** Opens the session in the transcript once the environment has it (`/new`), as well as putting the rail's cursor on it. */
  readonly opens?: boolean;
  /** What is typed into the workspace step as it opens (`/cwd <path>`). */
  readonly query?: string;
}

/** An account as its chip says it; "…" while the environment's accounts are being read. */
const accountWords = (view: NewSessionView, reading: boolean): string => view.account.value?.label ?? (reading ? "…" : "none");
/** A model as its chip says it: its display name alone, as the chip line holds every chip on one row. */
const modelWords = (view: NewSessionView, reading: boolean): string => {
  const model = view.model.value;
  return model !== null ? modelDisplayName(model.id, model.label) : reading ? "…" : "none";
};

/** The projection marks the browser chip, including the account's reach preset. */
const browserWords = (view: NewSessionView): string => view.browser.options.find((row) => row.selected)?.label ?? "Default";

/** The card on the environment `opening` presets, or the environment step when no environment is usable (the chip asks). */
export const newSessionCard = (acts: RailActs, opening: CardOpening): Picker => {
  const context = (chips: NewSessionChips | undefined) => ({ focus: opening.focus, ...(chips !== undefined && { chips }) });
  const first = acts.runtime.projections.newSession(context(opening.chips)).read().environment;
  const environmentId = first.value;
  const view = first.options.find((option) => option.environment.environmentId === environmentId)?.environment;
  if (environmentId === null || view === undefined) return environmentStep(acts, opening, undefined);
  // The environment the card opened on stays its chip's value until another is chosen, so no preset moves under it.
  const chips: NewSessionChips = { ...opening.chips, environmentId };
  const projection = acts.runtime.projections.newSession(context(chips));
  const sessionId = acts.newId();
  const rows = () => acts.runtime.projections.sessionList.read().rows;
  const reading = () => {
    const accounts = acts.runtime.projections.accounts(environmentId).read();
    const models = acts.runtime.projections.models(environmentId).read();
    return { accounts: accounts.value === null && accounts.loading, models: models.value === null && models.loading };
  };
  const chipsOf = (workspace?: string): Chip[] => {
    const now = projection.read();
    const read = reading();
    return [
      environmentChip(acts, view),
      { label: "account", value: accountWords(now, read.accounts) },
      { label: "model", value: modelWords(now, read.accounts || read.models) },
      { label: "workspace", value: workspace ?? (now.workspace.value === null ? "…" : requestLabel(now.workspace.value, sessionId, { environmentId, rows: rows() })) },
      { label: "browser", value: browserWords(now) },
    ];
  };
  const reopen = (changed: NewSessionChips): Picker => newSessionCard(acts, { ...opening, chips: changed, query: "" });
  const where = nameOf(view);
  const place: StepPlace = {
    acts,
    view,
    sessionId,
    known: () => projection.read().workspace.options,
    chips: chipsOf,
    follows: [projection],
    choose: (request, at) => {
      const now = projection.read();
      const account = now.account.value;
      const model = now.model.value;
      return sendFromStep(place, at, {
        request,
        send: (said, accepted, refused) =>
          acts.start(environmentId, { id: sessionId, workspace: request, browser: now.browser, ...(account !== null && { account: account.id }), ...(model !== null && { model: model.id }) }, said, accepted, refused),
        said: `Starting a session on ${where} in ${requestWords(request, sessionId, rows())}`,
        unsent: "No session was started",
        done: () => {
          acts.land(`${environmentId}/${sessionId}`);
          if (opening.opens === true) acts.openSession({ environmentId, sessionId });
        },
      });
    },
  };
  const change = (back: Picker): PickerRow[] => {
    const now = projection.read();
    const read = reading();
    return [
      { key: "change:environment", text: "Another environment", detail: `on ${where} now`, choose: () => environmentStep(acts, { ...opening, chips }, back) },
      { key: "change:account", text: "Another account", detail: accountWords(now, read.accounts), choose: () => accountStep(acts, view, projection, chips, back, reopen) },
      { key: "change:model", text: "Another model", detail: modelWords(now, read.accounts || read.models), choose: () => modelStep(acts, view, projection, chips, back, reopen) },
      { key: "change:browser", text: "Another browser", detail: browserWords(now), choose: () => browserPicker({
        runtime: acts.runtime, environmentId, title: `New session on ${where}: its browser`,
        rows: () => projection.read().browser.options, follows: [projection], back, say: acts.say,
        choose: (browser) => reopen({ ...chips, browser }),
      }) },
    ];
  };
  return workspaceStep(place, {
    title: `New session on ${where}: where it works`,
    preset: projection.read().workspace.value,
    more: change,
    ...(opening.query !== undefined && { query: opening.query }),
  });
};

/** Every environment this client knows, an unusable one greyed with the capability's line; the one chosen opens the card there. */
const environmentStep = (acts: RailActs, opening: CardOpening, back: Picker | undefined): Picker => {
  const projection = acts.runtime.projections.newSession({ focus: opening.focus, ...(opening.chips !== undefined && { chips: opening.chips }) });
  const current = opening.chips?.environmentId;
  const step = pickerOf({
    title: "New session: where it runs",
    typed: false,
    ...(back && { back }),
    follows: [projection],
    rows: () =>
      projection.read().environment.options.map(({ environment, unusable }): PickerRow => {
        const id = environment.environmentId;
        return {
          key: `environment:${id}`,
          text: nameOf(environment),
          ...withBadge(acts, id),
          ...(id === current && { detail: "the card's now" }),
          ...(unusable !== null ? { absent: unusable } : { choose: () => newSessionCard(acts, { ...opening, chips: { ...opening.chips, environmentId: id }, query: "" }) }),
        };
      }),
    note: () => {
      const { value, options } = projection.read().environment;
      if (options.length === 0) return "No environment is known here: /pair one first.";
      return value === null ? "No environment can start a session now: each says why." : undefined;
    },
  });
  const at = step.rows(step.query).findIndex((row) => row.key === `environment:${current}`);
  return at > 0 ? { ...step, cursor: at } : step;
};

type Projection = Observable<NewSessionView>;

/** The environment's accounts, each with its login or, not signed in, its status (the environment refuses a create on one); the one chosen is the account chip, on the card again. */
const accountStep = (acts: RailActs, view: EnvironmentView, projection: Projection, chips: NewSessionChips, back: Picker, reopen: (chips: NewSessionChips) => Picker): Picker => {
  const accounts = acts.runtime.projections.accounts(view.environmentId);
  const step = pickerOf({
    title: `New session on ${nameOf(view)}: its account`,
    typed: false,
    back,
    follows: [projection, accounts],
    rows: () => {
      const chosen = projection.read().account.value?.id;
      return projection.read().account.options.map((account: AccountRecord): PickerRow => {
        const words = account.status.state === "signed-in" ? identityWords(account) : ACCOUNT_STATUS_WORDS[account.status.state];
        return {
          key: `account:${account.id}`,
          text: account.label,
          detail: account.id === chosen ? `${words} · the card's now` : words,
          choose: () => reopen({ ...chips, account: { environmentId: view.environmentId, accountId: account.id } }),
        };
      });
    },
    note: () => {
      const answer = accounts.read();
      if (answer.value === null && answer.loading) return "Listing the accounts…";
      if (answer.error) return `The accounts could not be listed: ${answer.error.message}`;
      return answer.value?.length === 0 ? `${nameOf(view)} holds no account: /account adds one.` : undefined;
    },
  });
  const at = step.rows("").findIndex((row) => row.key === `account:${projection.read().account.value?.id}`);
  return at > 0 ? { ...step, cursor: at } : step;
};

/** The models the account chip's account offers; the one chosen is the model chip, on the card again. */
const modelStep = (acts: RailActs, view: EnvironmentView, projection: Projection, chips: NewSessionChips, back: Picker, reopen: (chips: NewSessionChips) => Picker): Picker => {
  const models = acts.runtime.projections.models(view.environmentId);
  const step = pickerOf({
    title: `New session on ${nameOf(view)}: its model`,
    typed: false,
    back,
    follows: [projection, models],
    rows: () => {
      const chosen = projection.read().model.value?.id;
      return projection.read().model.options.map(
        (model: ModelEntry): PickerRow => ({
          key: `model:${model.id}`,
          text: modelName(model),
          detail: model.id === chosen ? `${model.family} · the card's now` : model.family,
          choose: () => reopen({ ...chips, model: model.id }),
        }),
      );
    },
    note: () => {
      const answer = models.read();
      if (answer.value === null && answer.loading) return "Listing the models…";
      if (answer.error) return `The models could not be listed: ${answer.error.message}`;
      return projection.read().account.value === null ? "Choose an account first: its models are the ones offered." : undefined;
    },
  });
  const at = step.rows("").findIndex((row) => row.key === `model:${projection.read().model.value?.id}`);
  return at > 0 ? { ...step, cursor: at } : step;
};
