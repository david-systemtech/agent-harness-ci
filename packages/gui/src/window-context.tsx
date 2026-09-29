import type { Clock, Observable, Runtime } from "@agent-harness/client-runtime";
import { createContext, use, useCallback, useMemo, useSyncExternalStore, type ReactNode } from "react";
import type { Presentation, PresentationKey, PresentationValues } from "./presentation.js";

/**
 * What one window renders from (ADR 0004): its one client runtime, its
 * presentation, and its platform's clock. Components read the runtime's
 * projections through `useObservable` and act through its commands,
 * requests and drafts; they keep no copy of what a projection carries
 * (ADR 0003).
 */
interface WindowHolders {
  readonly runtime: Runtime;
  readonly presentation: Presentation;
  /** The platform's clock: what the window measures a silence on, a fake one in the tests. */
  readonly clock: Clock;
}

const WindowContext = createContext<WindowHolders | null>(null);

export const WindowProvider = ({ runtime, presentation, clock, children }: WindowHolders & { readonly children: ReactNode }) => {
  const holders = useMemo(() => ({ runtime, presentation, clock }), [runtime, presentation, clock]);
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

/** A runtime observable's value, read for React and followed while the component is mounted. */
export const useObservable = <T,>(observable: Observable<T>): T => useSyncExternalStore(observable.subscribe, observable.read);

/** One key of the window's presentation, and the setter that keeps it. */
export const usePresentation = <K extends PresentationKey>(key: K): readonly [PresentationValues[K], (value: PresentationValues[K]) => void] => {
  const { presentation } = useWindow();
  const value = useSyncExternalStore(presentation.values.subscribe, () => presentation.values.read()[key]);
  const set = useCallback((next: PresentationValues[K]) => presentation.set(key, next), [presentation, key]);
  return [value, set] as const;
};
