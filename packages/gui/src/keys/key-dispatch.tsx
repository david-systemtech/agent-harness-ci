import { writable, type Writable } from "@agent-harness/client-runtime";
import {
  ACTIONS,
  actionById,
  conditionWithin,
  isCommandId,
  type ActionCondition,
  type ActionContext,
  type ActionId,
  type KeyActionId,
} from "@agent-harness/contracts";
import { createContext, use, useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { chordOfEvent, chordOfKey, keyLabel, type PressedKey } from "./chords.js";
import { DEFAULT_KEY_MAP, keysInForce, type KeyMap } from "./key-map.js";

/**
 * Keys dispatch through the GUI column of the shared action list
 * (docs/specs/gui.md, "Keyboard: the GUI column"; ADR 0004, ADR 0022). The
 * window is the `anywhere` context; a surface marks the part of the window
 * where its keys mean what they mean with a region of its context
 * (`KeyContext`), and wires its own actions with `useKeyAction`, which the
 * nearest region of the action's context answers. A key pressed inside a
 * region is offered to it first, then to each region around it, and last to
 * the window, so a picker's Esc comes before the window's. Within a context
 * the actions holding the key are asked narrowest condition first: one whose
 * condition the region says does not hold gives the key to the next, as does
 * one that declines it (Tab with nothing to fill in), and a key no wired
 * action takes is left to the page. The keys are those in force
 * (`keys/key-map.ts`): the column's defaults with this client's remaps read
 * over them, and the keys the column writes `off` bound only while "Esc
 * stops the run" is on; the Keyboard shortcuts pane sets both.
 *
 * Esc pressed where no region takes it walks Escape's order before the
 * window's own actions hear it (`useEscapeStep`): a surface the window
 * closes (the focused pane's find bar), else the focused pane's parked
 * prompt, denied, else Settings, closed; only then `app.interrupt`, whose
 * Esc is bound while the switch is on. The palette, run info and the menus
 * take their Esc before any of it, the palette being modal and the others
 * Radix's layers, which close on Esc wherever the focus is.
 *
 * The window also lists every action wired in it, a key's and a slash
 * command's alike, with whether it can be done now (`useWindowAction`,
 * `useEveryWiredAction`): what the command palette lists and runs.
 *
 * A session pane the grid is not focused on wires none of its actions
 * (`KeysAnswered`), so the window's keys and the palette reach the focused
 * pane's alone (the pane grid, #407).
 */

/** An action the GUI column wires to keys in its context. */
interface Binding {
  readonly id: KeyActionId;
  readonly when: ActionCondition | undefined;
  /** Which of the action's keys this is, by its place in the column: ↑ is `composer.navigate`'s first, ↓ its second. */
  readonly key: number;
}

/**
 * What a wired action does with a key the column binds it to, told which of
 * its keys it was (by its place in the column); `false` declines it, and the
 * key goes on as if the action were not wired.
 */
export type KeyActionRun = (key: number) => void | false;

/** Who holds each key in each context (`holderKey`), narrowest condition first. */
type Holders = ReadonlyMap<string, readonly Binding[]>;

const holderKey = (context: ActionContext, chord: string) => `${context} ${chord}`;

/** The GUI column's bindings on this platform: every pressed action wired, with its keys in force. */
const holdersOf = (macOS: boolean, map: KeyMap): Holders => {
  const holders = new Map<string, Binding[]>();
  for (const action of ACTIONS) {
    if (isCommandId(action.id) || action.gui.status !== "wired") continue;
    const { when } = action.gui;
    keysInForce(action, map).forEach((key, place) => {
      const slot = holderKey(action.context, chordOfKey(key, macOS));
      holders.set(slot, [...(holders.get(slot) ?? []), { id: action.id as KeyActionId, when, key: place }]);
    });
  }
  const narrowestFirst = (a: Binding, b: Binding) => (a.when === b.when ? 0 : conditionWithin(a.when, b.when) ? -1 : 1);
  for (const bindings of holders.values()) bindings.sort(narrowestFirst);
  return holders;
};

/** What a region answers: whether each condition of its context holds now. A condition it does not answer does not hold. */
export type Conditions = Partial<Record<ActionCondition, () => boolean>>;

/** A part of the window where keys mean what they mean in one context. */
interface Region {
  readonly context: ActionContext;
  readonly parent: Region | null;
  /** The actions wired here, each run by the key the column binds it to. */
  readonly wired: Map<KeyActionId, KeyActionRun>;
  readonly conditions: { current: Conditions };
}

/**
 * Whether a wired action can be done now, as the command palette draws it:
 * present, or absent with the one line that says why (a capability's or a
 * session verb's answer, as the runtime words it).
 */
export type Offer = { readonly status: "present" } | { readonly status: "absent"; readonly message: string };

const PRESENT: Offer = { status: "present" };

/** An action the window has wired, as the command palette lists and runs it. */
export interface WiredAction {
  readonly id: ActionId;
  readonly offer: Offer;
  /** Whether the condition its keys are answered under holds now where it is wired; true for one answered under none. */
  holds(): boolean;
  /** Does it as its first key does; a slash command as if typed bare. */
  run(): void;
}

/**
 * Escape's order (docs/specs/gui.md, "Keyboard"; #418): what Esc pressed
 * where no region takes it does, first to last. A surface the window closes
 * (the find bar), then the focused pane's parked prompt, then Settings; the
 * last step, stopping the focused pane's run, is `app.interrupt`'s Esc,
 * bound only while "Esc stops the run" is on.
 */
export const ESCAPE_STEPS = ["surface", "prompt", "settings"] as const;
export type EscapeStep = (typeof ESCAPE_STEPS)[number];

/** What Esc does at a step of its order, for as long as the part of the window that does it is there. */
interface EscapeTaker {
  readonly step: EscapeStep;
  run(): void;
}

interface Dispatch {
  /** Who holds each key now, with the keys in force: changed when a remap or the switch is. */
  readonly holders: RefObject<Holders>;
  readonly macOS: boolean;
  /** Every action wired in the window now, in the order wired. */
  readonly wired: Writable<readonly WiredAction[]>;
  /** What Esc does at each step of its order now, in the order each came. */
  readonly escape: Set<EscapeTaker>;
}

const DispatchContext = createContext<Dispatch | null>(null);
/** Escape takers inside a dialog, offered before its document-capture dismissal. */
const EscapeBoundaryContext = createContext<Set<EscapeTaker> | null>(null);
const RegionContext = createContext<Region | null>(null);
/** The keys in force' source: the remaps and the switch, as the window holds them. */
const KeyMapContext = createContext<KeyMap>(DEFAULT_KEY_MAP);

/** Whether the actions wired below are wired now: false in a session pane the grid is not focused on. */
const AnsweredContext = createContext(true);

/**
 * A part of the window whose actions are wired only while `answered`: a
 * session pane of the grid, answered while it is the focused one. Its keys,
 * its palette entries and its slash commands' entries come and go with it.
 */
export const KeysAnswered = ({ answered, children }: { readonly answered: boolean; readonly children: ReactNode }) => <AnsweredContext value={answered}>{children}</AnsweredContext>;

/** Runs the action `region` has wired for the key `event` is, and says whether one took it. */
const offer = (dispatch: Dispatch, region: Region, event: PressedKey): boolean => {
  const chord = chordOfEvent(event, dispatch.macOS);
  if (chord === undefined) return false;
  for (const binding of dispatch.holders.current.get(holderKey(region.context, chord)) ?? []) {
    const run = region.wired.get(binding.id);
    if (run === undefined) continue;
    if (binding.when !== undefined && region.conditions.current[binding.when]?.() !== true) continue;
    if (run(binding.key) === false) continue;
    return true;
  }
  return false;
};

const newRegion = (context: ActionContext, parent: Region | null): Region => ({ context, parent, wired: new Map(), conditions: { current: {} } });

/** Walks Escape's order for a key that is Esc: the newest taker of the first step that has one does it. Says whether one did. */
const walkEscape = (dispatch: Dispatch, event: PressedKey, escape = dispatch.escape): boolean => {
  if (chordOfEvent(event, dispatch.macOS) !== "Esc") return false;
  const takers = [...escape].reverse();
  for (const step of ESCAPE_STEPS) {
    const taker = takers.find((each) => each.step === step);
    if (taker === undefined) continue;
    taker.run();
    return true;
  }
  return false;
};

interface KeyDispatchProps {
  readonly macOS: boolean;
  /** This client's remaps and "Esc stops the run": preset the column's defaults, the switch off. */
  readonly keyMap?: KeyMap;
  readonly children: ReactNode;
}

/**
 * The window's keys: the GUI column read for this platform with the keys in
 * force, and the window itself as the `anywhere` context, which hears every
 * key no region took, wherever the focus is, Esc walking Escape's order first.
 */
export const KeyDispatch = ({ macOS, keyMap = DEFAULT_KEY_MAP, children }: KeyDispatchProps) => {
  const holders = useMemo(() => holdersOf(macOS, keyMap), [macOS, keyMap]);
  const held = useRef(holders);
  useLayoutEffect(() => {
    held.current = holders;
  }, [holders]);
  const dispatch = useMemo<Dispatch>(() => ({ holders: held, macOS, wired: writable<readonly WiredAction[]>([]), escape: new Set() }), [macOS]);
  const window = useMemo(() => newRegion("anywhere", null), []);
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (!event.defaultPrevented && (walkEscape(dispatch, event) || offer(dispatch, window, event))) event.preventDefault();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [dispatch, window]);
  return (
    <DispatchContext value={dispatch}>
      <KeyMapContext value={keyMap}>
        <RegionContext value={window}>{children}</RegionContext>
      </KeyMapContext>
    </DispatchContext>
  );
};

/**
 * A part of the window whose keys mean what they mean in `context`,
 * answering whether each of the context's `conditions` holds when a key is
 * pressed. A key it takes goes no further; one it does not is offered to the
 * regions around it, then the window.
 */
export const KeyContext = ({ context, conditions = {}, children }: { readonly context: ActionContext; readonly conditions?: Conditions; readonly children: ReactNode }) => {
  const dispatch = use(DispatchContext);
  const parent = use(RegionContext);
  const region = useMemo(() => newRegion(context, parent), [context, parent]);
  useLayoutEffect(() => {
    region.conditions.current = conditions;
  });
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (dispatch === null || event.defaultPrevented || !offer(dispatch, region, event.nativeEvent)) return;
    event.preventDefault();
    event.stopPropagation();
  };
  return (
    <RegionContext value={region}>
      <div className="contents" data-key-context={context} onKeyDown={onKeyDown}>
        {children}
      </div>
    </RegionContext>
  );
};

const useDispatch = (): Dispatch => {
  const dispatch = use(DispatchContext);
  if (dispatch === null) throw new Error("A window's action is wired inside its KeyDispatch, which lists them.");
  return dispatch;
};

/** Gives a dialog's conversation first refusal of Escape without reaching the surrounding window. */
export const EscapeBoundary = ({ children }: { readonly children: (onEscapeKeyDown: (event: globalThis.KeyboardEvent) => void) => ReactNode }) => {
  const dispatch = useDispatch();
  const escape = useMemo(() => new Set<EscapeTaker>(), []);
  const onEscapeKeyDown = (event: globalThis.KeyboardEvent) => {
    if (!event.defaultPrevented && walkEscape(dispatch, event, escape)) event.preventDefault();
  };
  return <EscapeBoundaryContext value={escape}>{children(onEscapeKeyDown)}</EscapeBoundaryContext>;
};

/** A local menu takes Escape before its enclosing dialog; ordinary panes retain their input's handling. */
export const useLocalEscapeStep = (step: EscapeStep, run: () => void, active = true): void => {
  const escape = use(EscapeBoundaryContext);
  const answered = use(AnsweredContext);
  const latest = useRef(run);
  useLayoutEffect(() => { latest.current = run; });
  useEffect(() => {
    if (escape === null || !active || !answered) return;
    const taker: EscapeTaker = { step, run: () => latest.current() };
    escape.add(taker);
    return () => void escape.delete(taker);
  }, [escape, step, active, answered]);
};

const ALWAYS = () => true;

/**
 * Lists the action `id` among the window's wired actions for as long as the
 * component is mounted, with whether it can be done now (`offer`, present
 * unless given) and whether its keys' condition holds (`holds`): the command
 * palette lists it, drawn dim with the offer's line while it is absent, and
 * runs it with `run`.
 */
export const useWindowAction = (id: ActionId, run: () => void, offer: Offer = PRESENT, holds: () => boolean = ALWAYS): void => {
  const { wired } = useDispatch();
  const answered = use(AnsweredContext);
  const latest = useRef({ run, holds });
  useLayoutEffect(() => {
    latest.current = { run, holds };
  });
  const absent = offer.status === "absent" ? offer.message : undefined;
  useEffect(() => {
    if (!answered) return;
    const action: WiredAction = {
      id,
      offer: absent === undefined ? PRESENT : { status: "absent", message: absent },
      holds: () => latest.current.holds(),
      run: () => latest.current.run(),
    };
    wired.update((list) => [...list, action]);
    return () => wired.update((list) => list.filter((other) => other !== action));
  }, [wired, id, absent, answered]);
};

/** Every action wired in the window now, in the order wired, followed. */
export const useEveryWiredAction = (): readonly WiredAction[] => {
  const { wired } = useDispatch();
  return useSyncExternalStore(wired.subscribe, wired.read);
};

/** Whether the window's `Mod` is ⌘ (macOS) or Ctrl. */
export const useMacOS = (): boolean => useDispatch().macOS;

/** What the keys in force are read from: this client's remaps and "Esc stops the run" (`keysInForce`). */
export const useKeyMap = (): KeyMap => use(KeyMapContext);

/** The first of the action `id`'s keys in force, as this platform writes it (`Ctrl+F`, `⌘F`); undefined while it has none. */
export const useFirstKey = (id: KeyActionId): string | undefined => {
  const { macOS } = useDispatch();
  const map = useKeyMap();
  const action = actionById(id);
  const key = action === undefined ? undefined : keysInForce(action, map)[0];
  return key === undefined ? undefined : keyLabel(key, macOS);
};

/** Whether a key pressed is one of the action `id`'s keys in force on this platform. */
export const useIsKeyOf = (id: KeyActionId): ((event: PressedKey) => boolean) => {
  const dispatch = useDispatch();
  const context = actionById(id)?.context;
  return (event) => {
    const chord = chordOfEvent(event, dispatch.macOS);
    return context !== undefined && chord !== undefined && (dispatch.holders.current.get(holderKey(context, chord)) ?? []).some((binding) => binding.id === id);
  };
};

/**
 * Takes Esc at `step` of Escape's order while `active`, for as long as the
 * component is mounted: Esc pressed where no region takes it runs `run` when
 * no step before it has a taker, the newest taker of a step first. In a
 * part of the window not answered now (`KeysAnswered`, a session pane the
 * grid is not focused on) it takes nothing, so Esc reaches the focused
 * pane's alone.
 */
export const useEscapeStep = (step: EscapeStep, run: () => void, active = true): void => {
  const { escape } = useDispatch();
  const local = use(EscapeBoundaryContext);
  const answered = use(AnsweredContext);
  const latest = useRef(run);
  useLayoutEffect(() => {
    latest.current = run;
  });
  useEffect(() => {
    if (!active || !answered) return;
    const taker: EscapeTaker = { step, run: () => latest.current() };
    escape.add(taker);
    local?.add(taker);
    return () => { escape.delete(taker); local?.delete(taker); };
  }, [escape, local, step, active, answered]);
};

/**
 * Wires the action `id` to `run` for as long as the component is mounted:
 * the nearest region of the action's context runs it on the keys the GUI
 * column binds there, and `run` may decline a key (`false`). It is listed
 * among the window's wired actions too, with `offer` (`useWindowAction`),
 * its condition asked of that region. Throws when no region of that context
 * holds the component, since then no key could reach it. In a part of the
 * window not answered now (`KeysAnswered`), it is wired once that part is.
 */
export const useKeyAction = (id: KeyActionId, run: KeyActionRun, offer?: Offer): void => {
  const action = actionById(id);
  let region = use(RegionContext);
  while (region !== null && region.context !== action?.context) region = region.parent;
  if (region === null) throw new Error(`${id} is answered in the ${action?.context ?? "unknown"} context, and no region of it holds this component.`);
  const answered = use(AnsweredContext);
  const latest = useRef(run);
  useLayoutEffect(() => {
    latest.current = run;
  });
  useEffect(() => {
    if (!answered) return;
    const wired: KeyActionRun = (key) => latest.current(key);
    region.wired.set(id, wired);
    return () => {
      if (region.wired.get(id) === wired) region.wired.delete(id);
    };
  }, [region, id, answered]);
  const when = action?.gui.status === "wired" ? action.gui.when : undefined;
  useWindowAction(id, () => void latest.current(0), offer, () => when === undefined || region.conditions.current[when]?.() === true);
};
