import { writable, type RunChoice, type Writable } from "@agent-harness/client-runtime";
import { createContext, use, useCallback, useMemo, useSyncExternalStore, type ReactNode } from "react";

/**
 * What this window chose for a session's next runs, held in memory for the
 * life of the window, as the terminal UI holds it for its own (docs/specs/tui.md,
 * "Status, usage, pickers"; #402): the model and effort the model picker
 * chose, which the composer sends with the session's next `runs.start`, and
 * the account a hand-off forked the session onto, which its summary names
 * only once a run of it has used it. Neither is on the wire until a run
 * carries it, and neither is organisation state (ADR 0003): each is what
 * this client asks for next.
 */

interface Held {
  /** The model picker's choice per session (`<environment> <session>`). */
  readonly models: ReadonlyMap<string, RunChoice>;
  /** The account a hand-off forked each session onto. */
  readonly accounts: ReadonlyMap<string, string>;
}

const RunChoicesContext = createContext<Writable<Held> | null>(null);

/** The window's run choices, around everything that sends a run or says what the next one does. */
export const RunChoicesProvider = ({ children }: { readonly children: ReactNode }) => {
  const held = useMemo(() => writable<Held>({ models: new Map(), accounts: new Map() }), []);
  return <RunChoicesContext value={held}>{children}</RunChoicesContext>;
};

const useHeld = (): Writable<Held> => {
  const held = use(RunChoicesContext);
  if (held === null) throw new Error("A run choice is read inside the App, which holds the window's run choices.");
  return held;
};

const keyOf = (environmentId: string, sessionId: string) => `${environmentId} ${sessionId}`;

/** The model and effort this window chose for the session's next runs, and the setter that chooses another. */
export const useModelChoice = (environmentId: string, sessionId: string): readonly [RunChoice | undefined, (choice: RunChoice) => void] => {
  const held = useHeld();
  const key = keyOf(environmentId, sessionId);
  const choice = useSyncExternalStore(held.subscribe, () => held.read().models.get(key));
  const choose = useCallback((next: RunChoice) => held.update((now) => ({ ...now, models: new Map(now.models).set(key, next) })), [held, key]);
  return [choice, choose] as const;
};

/** The account this window handed the session off onto; undefined when it handed none. */
export const useHandedOnto = (environmentId: string, sessionId: string): string | undefined => {
  const held = useHeld();
  const key = keyOf(environmentId, sessionId);
  return useSyncExternalStore(held.subscribe, () => held.read().accounts.get(key));
};

/** Keeps the account a hand-off forked a session onto. */
export const useKeepHandedOnto = (): ((environmentId: string, sessionId: string, accountId: string) => void) => {
  const held = useHeld();
  return useCallback(
    (environmentId, sessionId, accountId) => held.update((now) => ({ ...now, accounts: new Map(now.accounts).set(keyOf(environmentId, sessionId), accountId) })),
    [held],
  );
};
