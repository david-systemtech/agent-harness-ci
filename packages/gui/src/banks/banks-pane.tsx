import { StepLinks } from "../settings/step-links.js";
import { usePickedEnvironment } from "../settings/settings-window.js";
import { useSetupView } from "../setup/use-setup.js";
import { MemoryBankCard } from "./memory-bank-card.js";

/** Settings and Set up read the same bank records and setup outcomes. */
export const BanksPane = () => {
  const view = usePickedEnvironment();
  const setup = useSetupView(view?.environmentId);
  const step = setup?.steps.find((candidate) => candidate.id === "memory-bank");
  return view === undefined || step === undefined ? null : <><StepLinks steps={["memory-bank"]} /><MemoryBankCard key={view.environmentId} environmentId={view.environmentId} step={step} /></>;
};
