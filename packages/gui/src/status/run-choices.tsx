import { writable, type Writable } from "@agent-harness/client-runtime";
import { createContext, use, useCallback, useMemo, useSyncExternalStore, type ReactNode } from "react";

/**
 * What this window chose for a session's next runs and holds itself, in
 * memory for the life of the window (#402): the account a hand-off forked
 * the session onto, which its summary names only once a run of it has used
 * it. It is not on the wire until a run carries it, and is not organisation
 * state (ADR 0003): it is what this client asks for next. The model and
 * effort are the session's own (`sessions.setModel`, the summary's
 * `runChoice`, #1961), so they outlive the window and the environment's
 * restarts, and every client names what the next run goes out on.
 */

interface Held {
  /** The account a hand-off forked each session onto (`<environment> <session>`). */
  readonly accounts: ReadonlyMap<string, string>;
}

const RunChoicesContext = createContext<Writable<Held> | null>(null);

/** The window's run choices, around everything that sends a run or says what the next one does. */
export const RunChoicesProvider = ({ children }: { readonly children: ReactNode }) => {
  const held = useMemo(() => writable<Held>({ accounts: new Map() }), []);
  return <RunChoicesContext value={held}>{children}</RunChoicesContext>;
};

const useHeld = (): Writable<Held> => {
  const held = use(RunChoicesContext);
  if (held === null) throw new Error("A run choice is read inside the App, which holds the window's run choices.");
  return held;
};

const keyOf = (environmentId: string, sessionId: string) => `${environmentId} ${sessionId}`;

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
