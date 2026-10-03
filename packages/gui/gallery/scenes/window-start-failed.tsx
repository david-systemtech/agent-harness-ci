import { Link, RotateCw } from "lucide-react";
import { LocalStartCard } from "../../src/connections/local-environment.js";
import { desktopErrorMessage } from "../../src/platform/desktop-platform.js";
import { Button, Tooltip } from "../../src/ui/index.js";

/** The same service card as the window, with a fake failure and inert remedies. */
export default function StartFailedScene() {
  const reason = desktopErrorMessage(new Error("Error invoking remote method 'shell:service.start': Error: No user service manager is available."));
  return <main className="flex min-h-screen flex-col bg-abyss text-ink">
    <LocalStartCard sentence={`The environment on this machine did not start: ${reason}`}>
      <div className="flex gap-2">
        <Tooltip content="Try again"><Button variant="default"><RotateCw aria-hidden="true" />Try again</Button></Tooltip>
        <Tooltip content="Pair instead"><Button variant="outline"><Link aria-hidden="true" />Pair instead</Button></Tooltip>
      </div>
    </LocalStartCard>
  </main>;
}
export const geometry = [
  { selector: "[data-welcome-tile]", width: 44, height: 44 },
  { selector: "[data-welcome-tile] svg", width: 22, height: 22 },
];
