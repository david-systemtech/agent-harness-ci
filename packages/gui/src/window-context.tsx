import type { Clock, Observable, Runtime, Shell } from "@agent-harness/client-runtime";
import { createContext, use, useCallback, useMemo, useSyncExternalStore, type ReactNode } from "react";
import type { Presentation, PresentationKey, PresentationValues } from "./presentation.js";

/**
 * What one window renders from (ADR 0004): its one client runtime, its
 * presentation, and its platform's clock and shell. Components read the runtime's
 * projections through `useObservable` and act through its commands,
 * requests and drafts; they keep no copy of what a projection carries
 * (ADR 0003).
 */
interface WindowHolders {
  readonly runtime: Runtime;
  readonly presentation: Presentation;
  /** The platform's clock: what the window measures a silence on, a fake one in the tests. */
  readonly clock: Clock;
  /** The platform's shell, absent in a browser tab: a member is used only once `capability` says it is present. */
  readonly shell?: Shell | undefined;
}

const WindowContext = createContext<WindowHolders | null>(null);

export const WindowProvider = ({ runtime, presentation, clock, shell, children }: WindowHolders & { readonly children: ReactNode }) => {
  const holders = useMemo(() => ({ runtime, presentation, clock, shell }), [runtime, presentation, clock, shell]);
  return <WindowContext value={holders}>{children}</WindowContext>;
};

const useWindow = (): WindowHolders => {
  const holders = use(WindowContext);
  if (holders === null) throw new Error("A window's component is rendered inside the App, which holds its runtime and presentation.");
  return holders;
};

/** The window's client runtime: its commands, requests, drafts and capabilities. */
export const useRuntime = (): Runtime => useWindow().runtime;

/** The platform's clock. */
export const useClock = (): Clock => useWindow().clock;

/** The platform's shell: the desktop's, undefined in a browser tab. Ask `capability` for a member before using it. */
export const useShell = (): Shell | undefined => useWindow().shell;

/** A runtime observable's value, read for React and followed while the component is mounted. */
export const useObservable = <T,>(observable: Observable<T>): T => useSyncExternalStore(observable.subscribe, observable.read);

const NOT_FOLLOWED = { subscribe: () => () => undefined, read: () => undefined };

/** A runtime observable's value while one is given, followed only then (a cached query fetched only while it is needed); undefined otherwise. */
export const useFollowed = <T,>(observable: Observable<T> | undefined): T | undefined => {
  const followed = observable ?? NOT_FOLLOWED;
  return useSyncExternalStore(followed.subscribe, followed.read);
};

/** A presentation value to keep: the value, or how to make it from the one held when it is kept. */
export type PresentationUpdate<V> = V | ((held: V) => V);

/**
 * One key of the window's presentation, and the setter that keeps it: given
 * a value, or a function of the value held when it runs, so two changes made
 * before the window draws again both land.
 */
export const usePresentation = <K extends PresentationKey>(key: K): readonly [PresentationValues[K], (next: PresentationUpdate<PresentationValues[K]>) => void] => {
  const { presentation } = useWindow();
  const value = useSyncExternalStore(presentation.values.subscribe, () => presentation.values.read()[key]);
  const set = useCallback(
    (next: PresentationUpdate<PresentationValues[K]>) => presentation.set(key, typeof next === "function" ? next(presentation.values.read()[key]) : next),
    [presentation, key],
  );
  return [value, set] as const;
};
