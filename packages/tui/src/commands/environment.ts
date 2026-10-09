import { clientOfferAskWords, type ConnectionKind, type EnvironmentView, type RequestAnswer, type Runtime } from "@agent-harness/client-runtime";
import {
  ENVIRONMENT_COLOURS,
  ENVIRONMENT_ICONS,
  ENVIRONMENT_NAME_MAX,
  EnvironmentColour,
  EnvironmentIcon,
  EnvironmentName,
  type ResultOf,
} from "@agent-harness/contracts";
import { ENVIRONMENT_ANSI } from "@agent-harness/theme";
import { pickerOf, type Picker, type PickerRow } from "../rail/picker.js";
import { messageOf, nameOf } from "../view.js";
import type { UpdateCard } from "./updates.js";

/**
 * `/environment` (docs/specs/tui.md, "First launch"): the saved
 * connections with phase, version and "unreachable since", and per
 * connection enable or disable, remove, set primary, and its client
 * sessions (`access.sessions.list`, `access.sessions.revoke`); the
 * environment's name, icon and colour (#327), which `/environment rename`,
 * `icon` and `colour` set too; and its update (#827, `updates.ts`). Every
 * action is a runtime call, an `access.*` request or a look or update
 * command sent as a direct request; nothing is kept here.
 */

/**
 * `name`, `icon` and `colour` set the environment's look (`LookField`);
 * `update` is Update now, `drain-and-update` Drain and update now (#878),
 * and `update-to-client` the offer of this client's version
 * (`commands/updates.ts`, #827).
 */
export type EnvironmentAction = "enable" | "disable" | "remove" | "primary" | "sessions" | LookField | "update" | "drain-and-update" | "update-to-client";

/**
 * The actions a connection offers, in the menu's order, by what its card
 * says of its `update`: Drain and update now only while busy work holds
 * the pending update, and the offer only while this client's version is
 * offered there.
 */
export const actionsFor = (view: EnvironmentView, update: UpdateCard): readonly EnvironmentAction[] => [
  view.enabled ? "disable" : "enable",
  "remove",
  ...(view.primary ? [] : (["primary"] as const)),
  "sessions",
  "name",
  "icon",
  "colour",
  "update",
  ...(update.drainable === null ? [] : (["drain-and-update"] as const)),
  ...(update.offered === null ? [] : (["update-to-client"] as const)),
];

const ACTION_WORDS: Readonly<Record<Exclude<EnvironmentAction, "update-to-client">, string>> = {
  enable: "Enable",
  disable: "Disable",
  remove: "Remove",
  primary: "Set primary",
  sessions: "Client sessions",
  name: "Rename",
  icon: "Icon",
  colour: "Colour",
  update: "Update now",
  "drain-and-update": "Drain and update now",
};

/** What an action says on the card; the offer names the environment and this client's version `offered`, as the window's button does. */
export const actionWords = (action: EnvironmentAction, view: EnvironmentView, offered: string | null): string =>
  action === "update-to-client" ? clientOfferAskWords(offered ?? "this client's version", nameOf(view)) : ACTION_WORDS[action];

/** Enables, disables or makes a connection the primary one; answers the line to show. */
export const applyAction = async (
  runtime: Runtime,
  view: EnvironmentView,
  action: "enable" | "disable" | "primary",
): Promise<string> => {
  try {
    if (action === "primary") {
      // Every saved connection, disabled ones included, as the runtime lists them now: `setOrder` takes the whole sequence.
      const others = runtime.projections.environments.read().filter((v) => v.environmentId !== view.environmentId);
      await runtime.connections.setOrder([view.environmentId, ...others.map((v) => v.environmentId)]);
      return `${nameOf(view)} is the primary environment.`;
    }
    await runtime.connections.setEnabled(view.environmentId, action === "enable");
    return action === "enable" ? `${nameOf(view)} is enabled.` : `${nameOf(view)} is disabled: its cache and saved connection stay.`;
  } catch (error) {
    return messageOf(error);
  }
};

/** Removes a connection: its client session there revoked when it can be, then forgotten here. */
export const removeEnvironment = async (runtime: Runtime, view: EnvironmentView): Promise<string> => {
  try {
    const result = await runtime.connections.remove(view.environmentId);
    return result.revoked ? `Removed ${nameOf(view)}; its client session there is revoked.` : `Removed ${nameOf(view)}. ${result.message}`;
  } catch (error) {
    return messageOf(error);
  }
};

export type ClientSessionRow = ResultOf<"access.sessions.list">["sessions"][number];

export type ClientSessionsOutcome = { readonly ok: true; readonly rows: readonly ClientSessionRow[] } | { readonly ok: false; readonly line: string };

/** The environment's live client sessions, or why they cannot be listed (`requests.call` answers absent with the reason without `admin`). */
export const listClientSessions = async (runtime: Runtime, view: EnvironmentView): Promise<ClientSessionsOutcome> => {
  const answer = await runtime.requests.call(view.environmentId, "access.sessions.list", { live: true });
  if (!answer.ok) return { ok: false, line: `Cannot list the client sessions on ${nameOf(view)}: ${answer.error.message}` };
  return { ok: true, rows: answer.result.sessions };
};

/** Revokes one client session; an own-session revoked close is the revoke committed before the reply (#1979). */
export const revokeClientSession = async (runtime: Runtime, view: EnvironmentView, row: ClientSessionRow, commandId: string, own?: ConnectionKind): Promise<string> => {
  const revoked = own === undefined ? `Revoked ${row.label} on ${nameOf(view)}.` : `Revoked this client. ${own === "local" ? "Try again" : "Pair again"} to reconnect.`;
  const answer = await runtime.requests.call(view.environmentId, "access.sessions.revoke", { commandId, clientSessionId: row.id });
  if (own !== undefined && !answer.ok && answer.error.bye === "revoked") return revoked;
  if (!answer.ok) return `Cannot revoke ${row.label} on ${nameOf(view)}: ${answer.error.message}`;
  const { receipt } = answer.result;
  return receipt.status === "accepted" ? revoked : `Revoking ${row.label} on ${nameOf(view)} was rejected: ${receipt.error.message}`;
};

/**
 * What `/environment` sets of the environment's look (workspace-picker spec,
 * "Name, icon and colour"; #327): its name, icon or colour, each through its
 * own `admin` command (`environment.rename`, `setIcon`, `setColour`), sent as
 * a direct request through the runtime (`requests.call`), never queued.
 */
export type LookField = "name" | "icon" | "colour";

/** A value checked for its field: what the command sends. */
export type LookChange =
  | { readonly field: "name"; readonly value: EnvironmentName }
  | { readonly field: "icon"; readonly value: EnvironmentIcon }
  | { readonly field: "colour"; readonly value: EnvironmentColour };

const LOOK_METHODS = { name: "environment.rename", icon: "environment.setIcon", colour: "environment.setColour" } as const;

/** What a line says it could not do, and what was rejected. */
const LOOK_WORDS: Readonly<Record<LookField, { readonly cannot: (name: string) => string; readonly rejected: (name: string) => string }>> = {
  name: { cannot: (name) => `rename ${name}`, rejected: (name) => `Renaming ${name}` },
  icon: { cannot: (name) => `set the icon of ${name}`, rejected: (name) => `Setting the icon of ${name}` },
  colour: { cannot: (name) => `set the colour of ${name}`, rejected: (name) => `Setting the colour of ${name}` },
};

/** What a name `environment.rename` takes is, in words. */
const NAME_RULE = `1 to ${ENVIRONMENT_NAME_MAX} characters, with no control characters`;

/** "a, b or c". */
const listed = (words: readonly string[]): string => `${words.slice(0, -1).join(", ")} or ${words.at(-1) ?? ""}`;

/** The capability's line when the connection cannot send the field's command (no `admin`, not ready); undefined when it can. */
export const lookRefusal = (runtime: Runtime, view: EnvironmentView, field: LookField): string | undefined => {
  const capability = runtime.capability(view.environmentId, LOOK_METHODS[field]);
  return capability.status === "absent" ? `Cannot ${LOOK_WORDS[field].cannot(nameOf(view))}: ${capability.message}` : undefined;
};

/** The value typed for `field` as its command takes it, or the line saying why it is none. */
export const lookChange = (field: LookField, typed: string): { readonly ok: true; readonly change: LookChange } | { readonly ok: false; readonly line: string } => {
  switch (field) {
    case "name": {
      const name = EnvironmentName.safeParse(typed);
      return name.success
        ? { ok: true, change: { field, value: name.data } }
        : { ok: false, line: `A name is ${NAME_RULE}; nothing was sent.` };
    }
    case "icon": {
      const icon = EnvironmentIcon.safeParse(typed.toLowerCase());
      return icon.success ? { ok: true, change: { field, value: icon.data } } : { ok: false, line: `There is no icon ${typed}: ${listed(ENVIRONMENT_ICONS)}.` };
    }
    case "colour": {
      const colour = EnvironmentColour.safeParse(typed.toLowerCase());
      return colour.success ? { ok: true, change: { field, value: colour.data } } : { ok: false, line: `There is no colour ${typed}: ${listed(ENVIRONMENT_COLOURS)}.` };
    }
  }
};

const sendLook = (runtime: Runtime, environmentId: string, change: LookChange, commandId: string): Promise<RequestAnswer<(typeof LOOK_METHODS)[LookField]>> => {
  switch (change.field) {
    case "name":
      return runtime.requests.call(environmentId, "environment.rename", { commandId, name: change.value });
    case "icon":
      return runtime.requests.call(environmentId, "environment.setIcon", { commandId, icon: change.value });
    case "colour":
      return runtime.requests.call(environmentId, "environment.setColour", { commandId, colour: change.value });
  }
};

/** Sends the change to the environment; answers the line to show: the new value, one already held, or the refusal's reason. */
export const setLook = async (runtime: Runtime, view: EnvironmentView, change: LookChange, commandId: string): Promise<string> => {
  const name = nameOf(view);
  const answer = await sendLook(runtime, view.environmentId, change, commandId);
  if (!answer.ok) return `Cannot ${LOOK_WORDS[change.field].cannot(name)}: ${answer.error.message}`;
  const { receipt, result } = answer.result;
  if (receipt.status === "rejected") return `${LOOK_WORDS[change.field].rejected(name)} was rejected: ${receipt.error.message}`;
  const now = receipt.changed ? "now" : "already";
  switch (change.field) {
    case "name":
      return `${name} is ${now} called ${result?.name ?? change.value}.`;
    case "icon":
      return `${name}'s icon is ${now} ${result?.icon ?? change.value}.`;
    case "colour":
      return `${name}'s colour is ${now} ${result?.colour ?? change.value}.`;
  }
};

/** What a look picker needs of the screen. */
export interface LookActs {
  readonly runtime: Runtime;
  say(line: string): void;
  newCommandId(): string;
}

/**
 * The picker a bare `/environment rename`, `icon` or `colour` opens, or the
 * card's Rename, Icon or Colour: a name typed, the ten icons, or the twelve
 * colours, each drawn in its own. It reads the environment as the runtime
 * lists it now, so a change another client makes is drawn while it is open.
 */
export const lookPicker = (acts: LookActs, view: EnvironmentView, field: LookField): Picker => {
  const now = () => acts.runtime.projections.environments.read().find((v) => v.environmentId === view.environmentId) ?? view;
  const send = (change: LookChange) => void setLook(acts.runtime, now(), change, acts.newCommandId()).then(acts.say);
  switch (field) {
    case "name":
      return pickerOf({
        title: () => `Rename ${nameOf(now())}`,
        typed: true,
        placeholder: `type its new name, up to ${ENVIRONMENT_NAME_MAX} characters`,
        note: (query) => (query.trim() === "" ? "Enter renames it once a name is typed." : undefined),
        rows: (query) => {
          const typed = query.trim();
          if (typed === "") return [];
          const checked = lookChange("name", typed);
          return [checked.ok ? { key: "rename", text: `Rename to ${checked.change.value}`, choose: () => send(checked.change) } : { key: "rename", text: typed, absent: NAME_RULE }];
        },
      });
    case "icon": {
      const rows = () => ENVIRONMENT_ICONS.map((icon): PickerRow => ({ key: icon, text: icon, ...(now().icon === icon && { detail: "now" }), choose: () => send({ field, value: icon }) }));
      return {
        ...pickerOf({ title: () => `Icon for ${nameOf(now())}`, typed: false, rows, note: () => "The terminal UI draws none; the window and other clients do." }),
        cursor: Math.max(0, ENVIRONMENT_ICONS.findIndex((icon) => icon === view.icon)),
      };
    }
    case "colour": {
      const rows = () =>
        ENVIRONMENT_COLOURS.map(
          (colour): PickerRow => ({ key: colour, text: colour, colour: ENVIRONMENT_ANSI[colour], ...(now().colour === colour && { detail: "now" }), choose: () => send({ field, value: colour }) }),
        );
      return {
        ...pickerOf({ title: () => `Colour for ${nameOf(now())}`, typed: false, rows }),
        cursor: Math.max(0, ENVIRONMENT_COLOURS.findIndex((colour) => colour === view.colour)),
      };
    }
  }
};
