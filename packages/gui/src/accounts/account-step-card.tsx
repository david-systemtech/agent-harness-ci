import { modelPreset, presetModelDefaults, uuidv7, type AccountOutcome, type EnvironmentView } from "@agent-harness/client-runtime";
import { settingsRow, type AccountRecord } from "@agent-harness/contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import { Part } from "../settings/part.js";
import type { StepCardProps } from "../setup/cards.js";
import { useHoldContinue } from "../setup/continue-hold.js";
import { MoreOptions } from "../setup/more-options.js";
import { StepStatus } from "../setup/step-status.js";
import { Input } from "../ui/index.js";
import { useClock, useObservable, useRuntime, useShell } from "../window-context.js";
import { AccountsList, SaidLine } from "./accounts-pane.js";
import { DefaultChoices } from "./default-model-pane.js";

/** Why Continue past Account waits (setup-copy.md §4.4; ADR 0018: the step needs a signed-in account to continue). */
const SIGN_IN_TO_CONTINUE = "Sign in to continue. Account is the one required step.";

/**
 * The Account step's card (setup-copy.md §5.1; the Set up specification,
 * "1. Account"; ADR 0018; #575, #1842): where the step stands, then one
 * question, how to sign in (this computer's Claude Code sign-in, from
 * `accounts.probe`, pre-selected while it is signed in; Sign in with Claude
 * always, on the sign-in card, one sign-in at a time), and a row per account.
 * After the first sign-in, one line says the model new sessions will use,
 * which the card presets (`usePresetOnFirstSignIn`). The step's More options
 * hold the name for the next new account and the default account, model
 * family and effort, written through `settings.update`. Continue waits until
 * an account on the environment checked is signed in; the step is never
 * skipped. Claude's parts alone: Codex and local models come with their
 * adapters (milestone 2, ADR 0016).
 */
export const AccountStepCard = ({ environmentId, step }: StepCardProps) => {
  const runtime = useRuntime();
  const shell = useShell();
  const view = useObservable(runtime.projections.environments).find((environment) => environment.environmentId === environmentId);
  const accounts = useObservable(useMemo(() => runtime.projections.accounts(environmentId), [runtime, environmentId])).value;
  const signedIn = accounts?.some((account) => account.status.state === "signed-in") ?? false;
  const [label, setLabel] = useState("");
  useHoldContinue(signedIn ? undefined : SIGN_IN_TO_CONTINUE);
  return (
    <>
      <StepStatus environmentId={environmentId} step={step} />
      {view !== undefined && (
        <>
          <AccountsList inlineSignIn={shell === undefined} view={view} label={label} labelTaken={() => setLabel("")} />
          <Preset view={view} accounts={accounts} />
          <MoreOptions step="account">
            <label className="flex flex-col gap-1 text-sm text-ink-muted">
              Label for the new account
              <Input value={label} onChange={(event) => setLabel(event.target.value)} className="w-64 max-w-full" />
            </label>
            <p className="text-xs text-ink-faint">Leave it empty to name the account by its email.</p>
            <Part title={settingsRow("accounts.default-model").label}>
              <DefaultChoices view={view} />
            </Part>
          </MoreOptions>
        </>
      )}
    </>
  );
};

/** What the preset did, after the first sign-in: the model new sessions will use, or to choose one, with why under Details. */
const Preset = ({ view, accounts }: { readonly view: EnvironmentView; readonly accounts: readonly AccountRecord[] | null }) => {
  const [said, say] = useState<AccountOutcome | undefined>(undefined);
  usePresetOnFirstSignIn(view, accounts, say);
  return said === undefined ? null : <SaidLine said={said} />;
};

/**
 * The preset of the default model family and effort (ADR 0018; the
 * claude-adapter spec left it to this card): once the card has read the
 * environment's accounts with none signed in, the first that signs in
 * (adopted, signed in with the code, or by another client) has the family
 * its catalogue ranks highest written at `high`, when both are unset
 * (`presetModelDefaults`), once its catalogue is read. The card writes it
 * once; an account already signed in as the card opened owes none.
 */
const usePresetOnFirstSignIn = (view: EnvironmentView, accounts: readonly AccountRecord[] | null, say: (outcome: AccountOutcome) => void) => {
  const runtime = useRuntime();
  const clock = useClock();
  const { environmentId } = view;
  const catalogues = useObservable(useMemo(() => runtime.projections.models(environmentId), [runtime, environmentId])).value;
  const writable = view.phase === "ready" && runtime.capability(environmentId, "settings.update").status === "present";
  /** Unread until the accounts are; waiting while none is signed in; the first signed in, owed its preset; null once nothing is owed. */
  const owed = useRef<"unread" | "waiting" | AccountRecord | null>("unread");

  useEffect(() => {
    if (accounts === null) return;
    const first = accounts.find((account) => account.status.state === "signed-in");
    if (owed.current === "unread") owed.current = first === undefined ? "waiting" : null;
    else if (owed.current === "waiting" && first !== undefined) owed.current = first;
    const account = owed.current;
    if (account === null || account === "waiting" || !writable) return;
    const preset = modelPreset(catalogues ?? [], account.id);
    if (preset === undefined) return;
    owed.current = null;
    void presetModelDefaults(runtime, environmentId, preset, uuidv7(clock.now())).then((written) => written !== undefined && say(written));
  }, [accounts, catalogues, writable]);
};
