import type { AccountRecord } from "@agent-harness/contracts";
import { createContext, use, useMemo, useState, type ReactNode } from "react";
import { SignInCard } from "../accounts/sign-in-card.js";
import { usePaneLine } from "../session/pane-line.js";
import { HandoffPicker } from "./hand-off.js";

/** The dialog a session pane has open over it: the sign-in card for an account (null: a new one), or the hand-off picker. */
type Open = { readonly kind: "sign-in"; readonly account: AccountRecord | null } | { readonly kind: "handoff" } | null;

interface Openers {
  readonly signIn: (account: AccountRecord | null) => void;
  readonly handoff: () => void;
}

const OpenersContext = createContext<Openers | null>(null);

/**
 * The dialogs a session pane opens over itself (#402): the sign-in card on
 * the session's environment and the hand-off picker, each opened from the
 * status line's pickers, its offer, or (the hand-off picker) Fork onto
 * another account under a message (#403). What either ends on is said on
 * the pane's line.
 */
export const PaneDialogs = ({ environmentId, sessionId, children }: { readonly environmentId: string; readonly sessionId: string; readonly children: ReactNode }) => {
  const [open, setOpen] = useState<Open>(null);
  const [, say] = usePaneLine();
  const openers = useMemo<Openers>(() => ({ signIn: (account) => setOpen({ kind: "sign-in", account }), handoff: () => setOpen({ kind: "handoff" }) }), []);
  const close = () => setOpen(null);
  return (
    <OpenersContext value={openers}>
      {children}
      {open?.kind === "sign-in" && <SignInCard environmentId={environmentId} account={open.account} close={close} say={say} />}
      {open?.kind === "handoff" && <HandoffPicker environmentId={environmentId} sessionId={sessionId} signIn={openers.signIn} close={close} />}
    </OpenersContext>
  );
};

const useOpeners = (): Openers => {
  const openers = use(OpenersContext);
  if (openers === null) throw new Error("A pane's dialog is opened inside a session pane, which holds its dialogs.");
  return openers;
};

/** Opens the sign-in card over the pane: for an account not signed in, or (null) a new account. */
export const useSignInCard = (): Openers["signIn"] => useOpeners().signIn;

/** Opens the hand-off picker over the pane. */
export const useHandoffPicker = (): Openers["handoff"] => useOpeners().handoff;
