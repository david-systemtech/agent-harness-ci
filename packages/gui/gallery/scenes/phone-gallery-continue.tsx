import { useMemo } from "react";
import { LocalServiceProvider } from "../../src/connections/local-service.js";
import { KeyDispatch } from "../../src/keys/key-dispatch.js";
import { SettingsProvider } from "../../src/settings/settings-window.js";
import { StepCardsContext } from "../../src/setup/cards.js";
import { stepState } from "../../src/setup/checklist-view.js";
import { ChecklistProvider } from "../../src/setup/checklist-window.js";
import { StepCard } from "../../src/setup/step-card.js";
import { WindowThemeProvider } from "../../src/theme/window-theme.js";
import { TooltipProvider } from "../../src/ui/tooltip.js";
import { useObservable, useRuntime } from "../../src/window-context.js";

export const platform = "web";
export const script = { environments: [{ name: "desk", reach: "paired" as const }] };

const Card = () => {
  const runtime = useRuntime();
  const environment = useObservable(runtime.projections.environments).find(e => e.phase === "ready");
  const environmentId = environment?.environmentId ?? "";
  const setup = useObservable(useMemo(() => runtime.projections.setup(environmentId), [runtime, environmentId]));
  const step = setup.steps.find(s => s.id === "permissions");
  return <div data-web-client className="flex h-dvh min-w-0 flex-col bg-abyss text-ink">{step && <StepCard environmentId={environmentId} step={step} state={stepState(step)} computer={environment?.name ?? null} />}</div>;
};

/** The real checklist footer, isolated from its desktop rail, on a browser runtime. */
export default function PhoneContinue() {
  return <WindowThemeProvider><TooltipProvider><LocalServiceProvider><KeyDispatch macOS={false}>
    <SettingsProvider><StepCardsContext value={{}}><ChecklistProvider><Card /></ChecklistProvider></StepCardsContext></SettingsProvider>
  </KeyDispatch></LocalServiceProvider></TooltipProvider></WindowThemeProvider>;
}
export const readySelector = 'footer[aria-label="Step navigation"] button';
export const geometry = [
  { selector: 'footer[aria-label="Step navigation"] button', minimumWidth: 44, minimumHeight: 44, visibleWithin: "[data-web-client]" },
];
