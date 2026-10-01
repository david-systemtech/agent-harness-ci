import { modelPreset, presetModelDefaults, uuidv7, type EnvironmentView } from "@agent-harness/client-runtime";
import { settingsRow, type AccountRecord } from "@agent-harness/contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import { Part } from "../settings/part.js";
import type { StepCardProps } from "../setup/cards.js";
import { useHoldContinue } from "../setup/continue-hold.js";
import { StepStatus } from "../setup/step-status.js";
import { useClock, useObservable, usePresentation, useRuntime } from "../window-context.js";
import { AccountsList } from "./accounts-pane.js";
import { DefaultChoices } from "./default-model-pane.js";

/** Why Continue past Account waits on first launch (ADR 0018: the step needs a signed-in account to continue). */
const WAITS_ON_AN_ACCOUNT = "Continue once an account is signed in.";

/**
 * The Account step's card (the Set up specification, "1. Account"; ADR
 * 0018; #575): where the step stands, then the accounts as the Accounts row
 * draws them (#414): this machine's Claude Code sign-in first, from
 * `accounts.probe`, with Adopt; Sign in another account, labelled first, on
 * the sign-in card (#402), one sign-in at a time with its countdown and
 * Cancel; a row per account with its label, identity, status and Sign in
 * again. Under the list, the default account, model family and effort,
 * written through `settings.update`, which the first account signed in
 * presets (`usePresetOnFirstSignIn`). On first launch, while the
 * first-launch mark is unset, Continue waits until an account on the
 * environment checked is signed in; the step is never skipped. Claude's
 * parts alone: Codex and local models come with their adapters
 * (milestone 2, ADR 0016).
 */
export const AccountStepCard = ({ environmentId, step }: StepCardProps) => {
  const runtime = useRuntime();
  const view = useObservable(runtime.projections.environments).find((environment) => environment.environmentId === environmentId);
  const accounts = useObservable(useMemo(() => runtime.projections.accounts(environmentId), [runtime, environmentId])).value;
  const [marked] = usePresentation("firstLaunchDone");
  const signedIn = accounts?.some((account) => account.status.state === "signed-in") ?? false;
  useHoldContinue(marked || signedIn ? undefined : WAITS_ON_AN_ACCOUNT);
  return (
    <>
      <StepStatus environmentId={environmentId} step={step} />
      {view !== undefined && (
        <>
          <AccountsList view={view} add="Sign in another account" />
          <Defaults view={view} accounts={accounts} />
        </>
      )}
    </>
  );
};

/** Under the list: the defaults, preset by the first account signed in, with what the preset did in one line. */
const Defaults = ({ view, accounts }: { readonly view: EnvironmentView; readonly accounts: readonly AccountRecord[] | null }) => {
  const [line, say] = useState<string | undefined>(undefined);
  usePresetOnFirstSignIn(view, accounts, say);
  return (
    <Part title={settingsRow("accounts.default-model").label}>
      <DefaultChoices view={view} />
      {line !== undefined && <p className="text-sm text-ink-muted">{line}</p>}
    </Part>
  );
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
const usePresetOnFirstSignIn = (view: EnvironmentView, accounts: readonly AccountRecord[] | null, say: (line: string) => void) => {
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
    void presetModelDefaults(runtime, environmentId, preset, account.label, uuidv7(clock.now())).then((written) => written !== undefined && say(written.line));
  }, [accounts, catalogues, writable]);
};
