import { homeEnvironment } from "@agent-harness/client-runtime";
import { STEP_ORDER, type SettingsRowId, type StepId } from "@agent-harness/contracts";
import { createContext, use, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useSettings, type SettingsPart } from "../settings/settings-window.js";
import { useObservable, usePresentation, useRuntime } from "../window-context.js";

/**
 * Set up as the whole window (docs/specs/gui.md, "Set up in the window";
 * ADR 0016): on first launch, once the home environment is ready and while
 * the first-launch mark is unset, the full checklist takes the window;
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
  /** Opens it on `step`, else on the step it showed last. */
  open(step?: StepId): void;
  /** Shows another step's card. */
  choose(step: StepId): void;
  /** Closes it and sets the first-launch mark: its Close, and Finish on the last step. */
  close(): void;
  /**
   * Leaves it for a row of Settings, on `environmentId` where the row picks
   * one, at `part` of its pane when one is named: a step's link to its home
   * row, or an action that opens one. The mark stays as it is, so a first
   * launch left this way comes back on the next.
   */
  leave(row: SettingsRowId, environmentId?: string, part?: SettingsPart): void;
}

const ChecklistContext = createContext<Checklist | null>(null);

export const useChecklist = (): Checklist => {
  const checklist = use(ChecklistContext);
  if (checklist === null) throw new Error("Set up is reached inside the ChecklistProvider, which the App holds.");
  return checklist;
};

/** Holds Set up as the whole window, and opens it on first launch once the home environment is ready. */
export const ChecklistProvider = ({ children }: { readonly children: ReactNode }) => {
  const { open: openRow } = useSettings();
  const [marked, mark] = usePresentation("firstLaunchDone");
  const home = homeEnvironment(useObservable(useRuntime().projections.environments));
  const [shown, setShown] = useState(false);
  const [left, setLeft] = useState(false);
  const [step, setStep] = useState<StepId>(STEP_ORDER[0]);

  // First launch: opened once the home environment is ready, and held open until it is finished, closed or left.
  const firstLaunch = !marked && !left && home?.phase === "ready";
  useEffect(() => {
    if (firstLaunch) setShown(true);
  }, [firstLaunch]);

  const open = useCallback((at?: StepId) => {
    if (at !== undefined) setStep(at);
    setShown(true);
  }, []);
  const close = useCallback(() => {
    mark(true);
    setShown(false);
  }, [mark]);
  const leave = useCallback(
    (row: SettingsRowId, environmentId?: string, part?: SettingsPart) => {
      setLeft(true);
      setShown(false);
      openRow(row, environmentId, part);
    },
    [openRow],
  );

  const checklist = useMemo<Checklist>(() => ({ shown, step, open, choose: setStep, close, leave }), [shown, step, open, close, leave]);
  return <ChecklistContext value={checklist}>{children}</ChecklistContext>;
};
