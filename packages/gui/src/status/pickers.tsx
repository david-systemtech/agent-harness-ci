import {
  ACCOUNT_STATUS_WORDS,
  MODE_BADGE_WORDS,
  aboveCeilingWords,
  containmentWords,
  identityWords,
  modelName,
  modelsOf,
  readingWords,
  gaugeOf,
  sessionModeOf,
  setSessionContainment,
  setSessionMode,
  type CapabilityName,
  type ContainmentBadge,
  type RunChoice,
} from "@agent-harness/client-runtime";
import { BYPASS_SENTENCE, CONTAINMENT_LEVELS, type AccountRecord } from "@agent-harness/contracts";
import { useMemo, useState, type ReactNode } from "react";
import { useSlashCommand } from "../composer/slash-commands.js";
import { THIS_MACHINE } from "../frame/sidebar-region.js";
import type { Offer } from "../keys/key-dispatch.js";
import { usePaneLine } from "../session/pane-line.js";
import { classes } from "../ui/classes.js";
import { Button, Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger, Tooltip } from "../ui/index.js";
import { useFollowed, useObservable, useRuntime } from "../window-context.js";
import { useHandOffOnto } from "./hand-off.js";
import { useSignInCard } from "./pane-dialogs.js";
import { useModelChoice } from "./run-choices.js";

/**
 * The status line's pickers (docs/specs/gui.md, "A session pane": pickers
 * per environment; #402), each a menu opened from its button on the line and
 * each over the session's environment. Each asks the connection whether it
 * can do what it does (`capability`): one it cannot is dim with the
 * capability's reason, which a press says on the pane's line. Each is its
 * slash command's too (`/account`, `/model`, `/mode`, `/containment`),
 * which opens it from the composer or the command palette. What each
 * choice does and says is the client runtime's (`setSessionMode`,
 * `setSessionContainment`, the hand-off), so the terminal UI says the same.
 *
 * - **Accounts**: the environment's accounts, each with its identity, its
 *   sign-in status and its identity's plan reading, then Add an account.
 *   An account not signed in starts its sign-in on the sign-in card; a
 *   session's account is fixed, so another signed-in account hands the
 *   session off onto it, the hand-off picker's fork.
 * - **Models**: the models of the session's account (every account's, once
 *   each, while the session has none) with their efforts, the model's own
 *   first; the choice goes with the session's next run.
 * - **Modes**: the four, one above the connection's ceiling greyed with the
 *   ceiling named. It can still be chosen: the environment's clamp answers
 *   it, and the line says the clamp (a mode is lowered, never refused).
 * - **Containment**: the three levels, one the environment cannot enforce
 *   greyed with the probe's reason. It can still be chosen: the refusal
 *   (`containment_unavailable`) is one line.
 */

interface PickerButtonProps {
  /** What the picker picks: its button is named for it and the value it shows (`Mode: ⏸ auto`). */
  readonly name: string;
  /** The value the button shows, in words. */
  readonly value: string;
  /** Whether the connection can do what the picker does. */
  readonly offer: Offer;
  readonly children: ReactNode;
  /** The menu's items. */
  readonly items: () => ReactNode;
  /** The slash command that opens it. */
  readonly command: "account" | "model" | "mode" | "containment";
}

const TRIGGER = "h-6 min-w-0 shrink gap-1 px-1.5 text-xs font-normal text-ink-muted";

/**
 * A picker's button and its menu. While the connection cannot do what it
 * does, the button is dim with the reason in its tooltip and opens nothing:
 * a press says the reason on the pane's line.
 */
const PickerButton = ({ name, value, offer, children, items, command }: PickerButtonProps) => {
  const [, say] = usePaneLine();
  const [open, setOpen] = useState(false);
  useSlashCommand(command, () => (offer.status === "absent" ? say(offer.message) : setOpen(true)), offer);
  const label = `${name}: ${value}`;
  if (offer.status === "absent") {
    return (
      <Tooltip content={offer.message}>
        <Button aria-label={label} aria-disabled="true" className={classes(TRIGGER, "cursor-default text-ink-faint hover:bg-transparent")} onClick={() => say(offer.message)}>
          {children}
        </Button>
      </Tooltip>
    );
  }
  return (
    <Menu open={open} onOpenChange={setOpen}>
      <MenuTrigger asChild>
        <Button aria-label={label} className={TRIGGER}>
          {children}
        </Button>
      </MenuTrigger>
      <MenuContent align="start" className="max-h-96 max-w-md overflow-y-auto">
        {items()}
      </MenuContent>
    </Menu>
  );
};

/** One item of a picker: what it names, dim when it is greyed, with a note after it and a line under it. */
const Item = (props: { readonly onSelect: () => void; readonly dim?: boolean; readonly note?: string | undefined; readonly under?: string | undefined; readonly children: ReactNode }) => (
  <MenuItem onSelect={props.onSelect}>
    <span className="flex min-w-0 flex-col">
      <span className={classes("flex items-baseline gap-2", props.dim === true && "text-ink-faint")}>
        <span>{props.children}</span>
        {props.note !== undefined && <span className="text-xs text-ink-faint">{props.note}</span>}
      </span>
      {props.under !== undefined && <span className="text-xs text-ink-faint">{props.under}</span>}
    </span>
  </MenuItem>
);

/** What a menu says while it has nothing to list: it is reading, or why it could not. */
const Waiting = ({ children }: { readonly children: ReactNode }) => <p className="px-2 py-1.5 text-xs text-ink-faint">{children}</p>;

/** Whether the connection can call `name` on the environment, as the runtime says. */
const useOffer = (environmentId: string, name: CapabilityName): Offer => {
  const runtime = useRuntime();
  // The connections' phases: the answer is asked again whenever one moves.
  useObservable(runtime.projections.environments);
  return runtime.capability(environmentId, name);
};

/** The environment's name as the line says it. */
const useEnvironmentName = (environmentId: string): string => {
  const environments = useObservable(useRuntime().projections.environments);
  return environments.find((view) => view.environmentId === environmentId)?.name ?? THIS_MACHINE;
};

/** The session's title as a line says it. */
const useSessionName = (environmentId: string, sessionId: string): string => {
  const runtime = useRuntime();
  const projection = useObservable(useMemo(() => runtime.projections.session(environmentId, sessionId), [runtime, environmentId, sessionId]));
  return projection.summary?.title ?? "this session";
};

interface AccountPickerProps {
  readonly environmentId: string;
  readonly sessionId: string;
  /** The session's account, as the status line says it; null for the environment's default. */
  readonly accountId: string | null;
}

/** The account picker: the environment's accounts, and Add an account. */
export const AccountPicker = ({ environmentId, sessionId, accountId }: AccountPickerProps) => {
  const runtime = useRuntime();
  const accounts = useObservable(useMemo(() => runtime.projections.accounts(environmentId), [runtime, environmentId]));
  const usage = useObservable(runtime.projections.usage);
  const environment = useEnvironmentName(environmentId);
  const listing = useOffer(environmentId, "accounts.list");
  const adding = useOffer(environmentId, "accounts.add");
  const signingIn = useOffer(environmentId, "accounts.signin.start");
  const [, say] = usePaneLine();
  const openSignIn = useSignInCard();
  const handOffOnto = useHandOffOnto(environmentId, sessionId);
  const account = accounts.value?.find((candidate) => candidate.id === accountId);

  const choose = (chosen: AccountRecord) => {
    if (chosen.status.state !== "signed-in") {
      if (signingIn.status === "absent") return say(`Cannot sign ${chosen.label} in on ${environment}: ${signingIn.message}`);
      return openSignIn(chosen);
    }
    handOffOnto(chosen);
  };
  const add = () => (adding.status === "absent" ? say(`Cannot add an account on ${environment}: ${adding.message}`) : openSignIn(null));

  const items = () => {
    if (accounts.value === null) return <Waiting>{accounts.error ? `The accounts could not be read: ${accounts.error.message}` : "Reading the accounts…"}</Waiting>;
    return (
      <>
        {accounts.value.map((candidate) => (
          <Item
            key={candidate.id}
            onSelect={() => choose(candidate)}
            note={[ACCOUNT_STATUS_WORDS[candidate.status.state], ...(candidate.id === accountId ? ["this session"] : [])].join(" · ")}
            under={readingWords(gaugeOf(usage.gauges, environmentId, candidate.id))}
          >
            <span className="font-medium">{candidate.label}</span> <span className="text-ink-muted">{identityWords(candidate)}</span>
          </Item>
        ))}
        <MenuSeparator />
        <Item onSelect={add} dim={adding.status === "absent"} under={adding.status === "absent" ? adding.message : undefined}>
          Add an account…
        </Item>
      </>
    );
  };
  return (
    <PickerButton
      name="Account" command="account"
      value={accountId === null ? "default account" : `${account?.label ?? accountId} ${account ? identityWords(account) : "not read yet"}`}
      offer={listing}
     
      items={items}
    >
      {accountId === null ? (
        <span className="text-ink-faint">default account</span>
      ) : (
        <>
          <span className="font-medium text-ink">{account?.label ?? accountId}</span> <span>{account ? identityWords(account) : "not read yet"}</span>
        </>
      )}
    </PickerButton>
  );
};

interface ModelPickerProps {
  readonly environmentId: string;
  readonly sessionId: string;
  readonly accountId: string | null;
  /** The model and effort the next run goes out on, as the status line says it; undefined for the default. */
  readonly model: RunChoice | undefined;
}

/** The model picker: the models of the session's account with their efforts; the choice rides the session's next run. */
export const ModelPicker = ({ environmentId, sessionId, accountId, model }: ModelPickerProps) => {
  const runtime = useRuntime();
  const catalogues = useObservable(useMemo(() => runtime.projections.models(environmentId), [runtime, environmentId]));
  const listing = useOffer(environmentId, "models.list");
  const [, choose] = useModelChoice(environmentId, sessionId);
  const [, say] = usePaneLine();
  const session = useSessionName(environmentId, sessionId);

  const words = model === undefined ? "default model" : model.effort !== null ? `${model.model} ${model.effort}` : model.model;
  const chosen = (id: string, effort: string | null) => {
    choose({ model: id, effort });
    say(`The next run of ${session} goes out on ${id} at ${effort === null ? "its own effort" : `${effort} effort`}.`);
  };
  const marked = (id: string, effort: string | null) => (model?.model === id && model.effort === effort ? "this session" : undefined);

  const items = () => {
    if (catalogues.value === null) return <Waiting>{catalogues.error ? `The models could not be read: ${catalogues.error.message}` : "Reading the models…"}</Waiting>;
    const models = modelsOf(catalogues.value, accountId);
    if (models.length === 0) return <Waiting>No model is listed for this account.</Waiting>;
    return models.map((entry) =>
      entry.efforts.length === 0 ? (
        <Item key={entry.id} onSelect={() => chosen(entry.id, null)} note={marked(entry.id, null)}>
          {modelName(entry)}
        </Item>
      ) : (
        <div key={entry.id} role="group" aria-label={modelName(entry)}>
          <MenuLabel>{modelName(entry)}</MenuLabel>
          {[null, ...entry.efforts].map((effort) => (
            <Item key={effort ?? ""} onSelect={() => chosen(entry.id, effort)} note={marked(entry.id, effort)}>
              {effort ?? "its own effort"}
            </Item>
          ))}
        </div>
      ),
    );
  };
  return (
    <PickerButton name="Model" command="model" value={words} offer={listing} items={items}>
      <span className={model === undefined ? "text-ink-faint" : "text-ink"}>{words}</span>
    </PickerButton>
  );
};

interface ModePickerProps {
  readonly environmentId: string;
  readonly sessionId: string;
  /** The mode badge the status line shows, with its clamp, in words. */
  readonly value: string;
  readonly children: ReactNode;
}

/** The mode picker: the four modes, one above the connection's ceiling greyed with the ceiling named, and the clamp said once set. */
export const ModePicker = ({ environmentId, sessionId, value, children }: ModePickerProps) => {
  const runtime = useRuntime();
  const picker = useObservable(useMemo(() => runtime.projections.modes(environmentId), [runtime, environmentId]));
  const projection = useObservable(useMemo(() => runtime.projections.session(environmentId, sessionId), [runtime, environmentId, sessionId]));
  const setting = useOffer(environmentId, "permissions.mode.set");
  const [, say] = usePaneLine();
  const session = projection.summary?.title ?? "this session";
  const own = sessionModeOf(projection.summary?.mode, picker.ceiling);

  const items = () =>
    picker.modes.map(({ mode, allowed }) => (
      <Item
        key={mode}
        onSelect={() => void setSessionMode(runtime, environmentId, sessionId, mode, session).then((set) => say(set.line))}
        dim={!allowed}
        note={!allowed ? aboveCeilingWords(picker.ceiling) : mode === own ? "this session" : undefined}
        under={mode === "bypassPermissions" ? BYPASS_SENTENCE : undefined}
      >
        {MODE_BADGE_WORDS[mode]}
      </Item>
    ));
  return (
    <PickerButton name="Mode" command="mode" value={value} offer={setting} items={items}>
      {children}
    </PickerButton>
  );
};

interface ContainmentPickerProps {
  readonly environmentId: string;
  readonly sessionId: string;
  /** The level the status line shows: the session's own, or the default marked so. */
  readonly containment: ContainmentBadge | undefined;
}

/** The containment picker: the three levels, one the environment cannot enforce greyed with the probe's reason. */
export const ContainmentPicker = ({ environmentId, sessionId, containment }: ContainmentPickerProps) => {
  const runtime = useRuntime();
  const permissions = useFollowed(useMemo(() => runtime.requests.cached(environmentId, "permissions.settings.get", {}), [runtime, environmentId]));
  const setting = useOffer(environmentId, "permissions.containment.set");
  const [, say] = usePaneLine();
  const session = useSessionName(environmentId, sessionId);
  const environment = useEnvironmentName(environmentId);
  const report = permissions?.result?.containment;
  const value = containment === undefined ? "containment not read yet" : containmentWords(containment.level, containment.isDefault);

  const items = () => (
    <>
      {CONTAINMENT_LEVELS.map((level) => {
        const availability = report?.levels.find((candidate) => candidate.level === level);
        const unavailable = availability?.available === false ? (availability.reason ?? "the environment cannot enforce it") : undefined;
        const marked = containment?.level === level ? (containment.isDefault ? "the default" : "this session") : undefined;
        return (
          <Item
            key={level}
            onSelect={() => void setSessionContainment(runtime, environmentId, sessionId, level, { session, environment }).then((set) => say(set.line))}
            dim={unavailable !== undefined}
            note={unavailable !== undefined ? `not available here: ${unavailable}` : marked}
          >
            {containmentWords(level, false)}
          </Item>
        );
      })}
      {permissions?.error && <Waiting>What {environment} can enforce could not be read: {permissions.error.message}</Waiting>}
    </>
  );
  return (
    <PickerButton name="Containment" command="containment" value={value} offer={setting} items={items}>
      <span className={containment?.level === "off" ? "text-amber" : undefined}>{value}</span>
    </PickerButton>
  );
};
