import { CredentialNoticeProvider } from "../notices/credential-notice.js";
import { homeEnvironment, LOCAL_PLACEHOLDER_ID } from "@agent-harness/client-runtime";
import { STEP_ORDER, type SettingsRowId, type StepId } from "@agent-harness/contracts";
import { ArrowLeft, LogOut } from "lucide-react";
import { createContext, use, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { usePickedEnvironment, useSettings, type SettingsPart } from "../settings/settings-window.js";
import { useObservable, usePresentation, useRuntime } from "../window-context.js";
import { Button, Dialog, DialogContent, Tooltip } from "../ui/index.js";
import { ChecklistAuthoringProvider } from "./authoring-run.js";
import { Introduction } from "./introduction.js";

/**
 * Set up as the whole window (docs/specs/gui.md, "Set up in the window";
 * ADR 0016): on first launch, the introduction takes the window from the
 * first frame while the mark is unset. Begin set up opens the full checklist
 * once the home environment is ready;
 * finishing or closing it sets the mark, and the Set up pane's "Open the
 * full checklist", a step's link and Re-run bring it back. Whether it is
 * shown and the step whose card it shows live as long as the window does;
 * the results it draws are the client runtime's (`projections.setup`), the
 * window keeping none (ADR 0004).
 */
export interface Checklist {
  /** Whether Set up takes the whole window. */
  readonly shown: boolean;
  /** The step whose card it shows. */
  readonly step: StepId;
  /** The part of the step's card the last opening asked to go to; undefined when it asked for none, or another step was chosen since. */
  readonly part: StepPart | undefined;
  /** Opens it on `step`, else on the step it showed last, at `part` of its card when one is named. */
  open(step?: StepId, part?: StepPart): void;
  /** The computer whose check just opened this card; cleared by other navigation. */
  readonly checkedEnvironmentId: string | undefined;
  /** Opens the first step needing a fix after Check everything again on this computer. */
  openChecked(step: StepId, environmentId: string): void;
  /** Shows another step's card. */
  choose(step: StepId): void;
  /** Closes it and sets the first-launch mark: its Close, and Finish on the last step. */
  close(): void;
  /** Leaves it for the main window, sets the first-launch mark, and keeps this checklist run's authoring state. */
  leaveForMain(): void;
  /**
   * Leaves it for a row of Settings, on `environmentId` where the row picks
   * one, at `part` of its pane when one is named: a step's link to its home
   * row, or an action that opens one. The mark stays as it is, so a first
   * launch left this way comes back on the next.
   */
  leave(row: SettingsRowId, environmentId?: string, part?: SettingsPart): void;
}

/** A part of a step's card an opening may go to, which takes the focus: the Key manager card's Move stored tokens (#590). */
export type StepPart = "move-stored-tokens";

const ChecklistContext = createContext<Checklist | null>(null);

export const useChecklist = (): Checklist => {
  const checklist = use(ChecklistContext);
  if (checklist === null) throw new Error("Set up is reached inside the ChecklistProvider, which the App holds.");
  return checklist;
};

/** Holds Set up as the whole window, and shows its introduction from the first frame on first launch. */
export const ChecklistProvider = ({ children }: { readonly children: ReactNode }) => {
  const { open: openRow } = useSettings();
  const [marked, mark] = usePresentation("firstLaunchDone");
  const runtime = useRuntime();
  const home = homeEnvironment(useObservable(runtime.projections.environments));
  const [shown, setShown] = useState(!marked);
  const [introduction, setIntroduction] = useState(!marked);
  const [confirmClose, setConfirmClose] = useState(false);
  const [authoringRunId, setAuthoringRunId] = useState(0);
  const [step, setStep] = useState<StepId>(STEP_ORDER[0]);
  const [part, setPart] = useState<StepPart | undefined>(undefined);
  const [checkedEnvironmentId, setCheckedEnvironmentId] = useState<string | undefined>(undefined);
  const picked = usePickedEnvironment();
  // The introduction has no picker; the checklist closes against the computer its header shows (setup-copy.md §4.3).
  const accountEnvironmentId = (introduction ? home : picked)?.environmentId ?? LOCAL_PLACEHOLDER_ID;
  const accounts = useObservable(useMemo(() => runtime.projections.accounts(accountEnvironmentId), [runtime, accountEnvironmentId])).value;
  const signedIn = accounts?.some((account) => account.status.state === "signed-in") ?? false;
  useEffect(() => setCheckedEnvironmentId(undefined), [picked?.environmentId]);

  const open = useCallback((at?: StepId, to?: StepPart) => {
    if (at !== undefined) setStep(at);
    setPart(to);
    setCheckedEnvironmentId(undefined);
    setIntroduction(false);
    setShown(true);
  }, []);
  const openChecked = useCallback((at: StepId, environmentId: string) => {
    open(at);
    setCheckedEnvironmentId(environmentId);
  }, [open]);
  const choose = useCallback((at: StepId) => {
    setStep(at);
    setPart(undefined);
    setCheckedEnvironmentId(undefined);
  }, []);
  const finish = useCallback(() => {
    mark(true);
    setConfirmClose(false);
    setShown(false);
    setAuthoringRunId((id) => id + 1);
  }, [mark]);
  const close = useCallback(() => {
    if (signedIn) finish();
    else setConfirmClose(true);
  }, [signedIn, finish]);
  const leaveForMain = useCallback(() => {
    mark(true);
    setShown(false);
  }, [mark]);
  const leave = useCallback(
    (row: SettingsRowId, environmentId?: string, part?: SettingsPart) => {
      setShown(false);
      openRow(row, environmentId, part);
    },
    [openRow],
  );

  const checklist = useMemo<Checklist>(() => ({ shown, step, part, checkedEnvironmentId, open, openChecked, choose, close, leaveForMain, leave }), [shown, step, part, checkedEnvironmentId, open, openChecked, choose, close, leaveForMain, leave]);
  return <ChecklistContext value={checklist}>
    <CredentialNoticeProvider>
    <ChecklistAuthoringProvider runId={authoringRunId}>
      {shown && introduction ? <Introduction home={home} onBegin={() => { if (home?.phase === "ready") open("account"); }} onLater={close} /> : children}
      <Dialog open={confirmClose} onOpenChange={setConfirmClose}>
        <DialogContent onKeyDown={(event) => { event.stopPropagation(); if (event.key === "Escape") { event.preventDefault(); setConfirmClose(false); } }} title="Leave set up without an account?" description="You can look around, but you will need to sign in before starting a session. Set up will be waiting in Settings.">
          <div className="flex flex-wrap justify-end gap-2">
            <Tooltip content="Keep setting up" keys="Tab, Enter"><Button variant="outline" onClick={() => setConfirmClose(false)}><ArrowLeft aria-hidden="true" />Keep setting up</Button></Tooltip>
            <Tooltip content="Leave for now" keys="Tab, Enter"><Button variant="default" onClick={finish}><LogOut aria-hidden="true" />Leave for now</Button></Tooltip>
          </div>
        </DialogContent>
      </Dialog>
    </ChecklistAuthoringProvider>
    </CredentialNoticeProvider>
  </ChecklistContext>;
};
