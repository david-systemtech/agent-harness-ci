import { ACTIONS, actionById, isCommandId } from "@agent-harness/contracts";
import { createContext, use, useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from "react";
import { useWindowAction, type Offer } from "../keys/key-dispatch.js";

/**
 * The window's slash commands (docs/specs/gui.md, "Keyboard: the GUI
 * column"; #400). A slash command is one of the shared action list's
 * (`command.<name>`), typed at the composer; the GUI column says whether the
 * window wires it. A surface wires the commands it answers with
 * `useSlashCommand`, as it wires its keys, for as long as it is mounted: the
 * composer's menu offers what is wired now, and Enter on a wired command runs
 * it with what follows its name.
 *
 * What is typed after a `/` is read as the terminal UI reads it: a name of
 * the list (or a hidden alias of one) is the window's, never the agent's, so
 * one the window does not answer says why in one line; any other word goes
 * to the agent as typed, which is how the provider's own commands run.
 *
 * A wired command is listed among the window's wired actions too, which the
 * command palette runs it from.
 */

/** A slash command a surface wired: its name as typed, its usage and description from the list, and what it does. */
export interface WiredCommand {
  readonly name: string;
  readonly usage: string;
  readonly description: string;
  readonly availability?: Offer;
  /** Runs it with what was typed after its name; check preserves shell text. */
  readonly run: (argument: string) => void;
}

/** The commands wired in one part of the window, and who hears them change. */
interface Wiring {
  readonly read: () => readonly WiredCommand[];
  readonly subscribe: (listener: () => void) => () => void;
  wire(command: WiredCommand): () => void;
}

/** Where a command stands in the shared list: the menu lists what is wired in the list's order, as the command palette does. */
const placeOf = (name: string): number => ACTIONS.findIndex((action) => action.id === `command.${name}`);

const newWiring = (): Wiring => {
  let wired: readonly WiredCommand[] = [];
  const listeners = new Set<() => void>();
  const changed = (next: readonly WiredCommand[]) => {
    wired = next;
    for (const listener of [...listeners]) listener();
  };
  return {
    read: () => wired,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    wire(command) {
      changed([...wired.filter((other) => other.name !== command.name), command].sort((a, b) => placeOf(a.name) - placeOf(b.name)));
      return () => {
        if (wired.includes(command)) changed(wired.filter((other) => other !== command));
      };
    },
  };
};

const WiringContext = createContext<Wiring | null>(null);

/** The part of the window whose surfaces wire slash commands for one composer: a session pane. */
export const SlashCommands = ({ children }: { readonly children: ReactNode }) => {
  const wiring = useMemo(newWiring, []);
  return <WiringContext value={wiring}>{children}</WiringContext>;
};

const useWiring = (): Wiring => {
  const wiring = use(WiringContext);
  if (wiring === null) throw new Error("A slash command is wired inside a session pane, which holds its composer.");
  return wiring;
};

/**
 * Wires the slash command `name` to `run` for as long as the component is
 * mounted, and lists it among the window's wired actions with `offer`,
 * whether it can be done now, so the command palette runs it as if typed
 * bare. Throws for a name the shared list does not hold or keeps absent in
 * the GUI column, and for an alias, since no key could then reach it as
 * wired.
 */
export const useSlashCommand = (name: string, run: (argument: string) => void, offer?: Offer): void => {
  const wiring = useWiring();
  const action = actionById(`command.${name}`);
  if (action === undefined || action.aliasOf !== undefined || action.gui.status !== "wired" || action.usage === undefined) {
    throw new Error(`/${name} is not a slash command the GUI column wires.`);
  }
  const { usage, description } = action;
  const latest = useRef(run);
  useLayoutEffect(() => {
    latest.current = run;
  });
  useEffect(() => wiring.wire({ name, usage, description, run: (argument) => latest.current(argument), ...(offer === undefined ? {} : { availability: offer }) }), [wiring, name, usage, description, offer?.status, offer?.status === "absent" ? offer.message : undefined]);
  useWindowAction(action.id, () => latest.current(""), offer);
};

/** The slash commands wired now, in the shared list's order. */
export const useWiredCommands = (): readonly WiredCommand[] => {
  const wiring = useWiring();
  return useSyncExternalStore(wiring.subscribe, wiring.read);
};

/** A slash command of the shared list, as typed: its name (an alias read as what it names) and what follows it. */
export interface TypedCommand {
  readonly name: string;
  readonly argument: string;
}

/**
 * The command of the shared list `text` types, if it types one: a `/`, a
 * name of the list or a hidden alias of one, ignoring case, then anything.
 * Any other text, another word after a `/` included, is for the agent.
 */
export const typedCommand = (text: string): TypedCommand | undefined => {
  const check = /^\/check(?:\s([\s\S]*)|$)/i.exec(text.trimStart());
  if (check !== null) return { name: "check", argument: check[1] ?? "" };
  const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (match === null) return undefined;
  const typed = `command.${(match[1] ?? "").toLowerCase()}`;
  if (!isCommandId(typed)) return undefined;
  const named = actionById(typed)?.aliasOf ?? typed;
  return { name: named.slice("command.".length), argument: (match[2] ?? "").trim() };
};

/** Why the window does not run `name`, a command of the list no surface has wired: the GUI column's reason, or that it is not built yet. */
export const notWired = (name: string): string => {
  const action = actionById(`command.${name}`);
  return action?.gui.status === "absent" ? `/${name} is not here: ${action.gui.reason}` : `/${name} is not in this build of the window yet.`;
};
