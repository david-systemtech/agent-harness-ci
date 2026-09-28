import {
  ACTIONS,
  actionById,
  conditionWithin,
  isCommandId,
  type ActionCondition,
  type ActionContext,
  type KeyActionId,
} from "@agent-harness/contracts";
import { createContext, use, useEffect, useLayoutEffect, useMemo, useRef, type KeyboardEvent, type ReactNode } from "react";
import { chordOfEvent, chordOfKey, type PressedKey } from "./chords.js";

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
 * condition the region says does not hold gives the key to the next, and a
 * key no wired action takes is left to the page. Keys the column writes
 * `off` are not bound. Remaps and the switch that turns Esc's stop on are
 * the Keyboard shortcuts pane's.
 */

/** An action the GUI column wires to keys in its context. */
interface Binding {
  readonly id: KeyActionId;
  readonly when: ActionCondition | undefined;
}

/** Who holds each key in each context (`holderKey`), narrowest condition first. */
type Holders = ReadonlyMap<string, readonly Binding[]>;

const holderKey = (context: ActionContext, chord: string) => `${context} ${chord}`;

/** The GUI column's bindings on this platform: every pressed action wired with keys not written off. */
const holdersOf = (macOS: boolean): Holders => {
  const holders = new Map<string, Binding[]>();
  for (const action of ACTIONS) {
    if (isCommandId(action.id) || action.gui.status !== "wired" || action.gui.off === true) continue;
    for (const key of action.gui.keys) {
      const slot = holderKey(action.context, chordOfKey(key, macOS));
      holders.set(slot, [...(holders.get(slot) ?? []), { id: action.id as KeyActionId, when: action.gui.when }]);
    }
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
  readonly wired: Map<KeyActionId, () => void>;
  readonly conditions: { current: Conditions };
}

interface Dispatch {
  readonly holders: Holders;
  readonly macOS: boolean;
}

const DispatchContext = createContext<Dispatch | null>(null);
const RegionContext = createContext<Region | null>(null);

/** Runs the action `region` has wired for the key `event` is, and says whether one ran. */
const offer = (dispatch: Dispatch, region: Region, event: PressedKey): boolean => {
  const chord = chordOfEvent(event, dispatch.macOS);
  if (chord === undefined) return false;
  for (const binding of dispatch.holders.get(holderKey(region.context, chord)) ?? []) {
    const run = region.wired.get(binding.id);
    if (run === undefined) continue;
    if (binding.when !== undefined && region.conditions.current[binding.when]?.() !== true) continue;
    run();
    return true;
  }
  return false;
};

const newRegion = (context: ActionContext, parent: Region | null): Region => ({ context, parent, wired: new Map(), conditions: { current: {} } });

/**
 * The window's keys: the GUI column read for this platform, and the window
 * itself as the `anywhere` context, which hears every key no region took,
 * wherever the focus is.
 */
export const KeyDispatch = ({ macOS, children }: { readonly macOS: boolean; readonly children: ReactNode }) => {
  const dispatch = useMemo<Dispatch>(() => ({ holders: holdersOf(macOS), macOS }), [macOS]);
  const window = useMemo(() => newRegion("anywhere", null), []);
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (!event.defaultPrevented && offer(dispatch, window, event)) event.preventDefault();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [dispatch, window]);
  return (
    <DispatchContext value={dispatch}>
      <RegionContext value={window}>{children}</RegionContext>
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

/**
 * Wires the action `id` to `run` for as long as the component is mounted:
 * the nearest region of the action's context runs it on the keys the GUI
 * column binds there. Throws when no region of that context holds the
 * component, since then no key could reach it.
 */
export const useKeyAction = (id: KeyActionId, run: () => void): void => {
  const context = actionById(id)?.context;
  let region = use(RegionContext);
  while (region !== null && region.context !== context) region = region.parent;
  if (region === null) throw new Error(`${id} is answered in the ${context ?? "unknown"} context, and no region of it holds this component.`);
  const latest = useRef(run);
  useLayoutEffect(() => {
    latest.current = run;
  });
  useEffect(() => {
    const wired = () => latest.current();
    region.wired.set(id, wired);
    return () => {
      if (region.wired.get(id) === wired) region.wired.delete(id);
    };
  }, [region, id]);
};
