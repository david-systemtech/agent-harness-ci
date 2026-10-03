import { PRODUCT_NAME } from "@agent-harness/contracts";
import { TriangleAlert } from "lucide-react";
import { useKeyMap, useMacOS } from "../keys/key-dispatch.js";
import { Welcome } from "../session/empty-state.js";
import { Alert, AlertDescription, AlertTitle } from "../ui/index.js";
import { PairingForm } from "./pairing.js";
import { RunHereSwitch } from "./run-here.js";

/** Pairing and local startup keep the welcome and its key legend in the same place. */
export const PairingPane = () => {
  const keyMap = useKeyMap();
  const macOS = useMacOS();
  return <section aria-label="Pair with an environment" className="flex min-h-0 flex-1 flex-col overflow-auto">
    <Welcome keyMap={keyMap} macOS={macOS}>
      <Alert className="w-full text-left">
        <TriangleAlert aria-hidden="true" className="text-amber" />
        <AlertTitle>Not ready to run</AlertTitle>
        <AlertDescription>Pair with an environment, or run one on this machine.</AlertDescription>
      </Alert>
      <div className="flex w-full flex-col gap-4 text-left">
        <h3 className="text-sm font-medium text-ink">Pair with an environment</h3>
        <p className="text-xs text-ink-muted">Paste the pairing link another client made (Your machines, or <code>{PRODUCT_NAME} pair</code> on the environment's machine), or type the environment's address and its code.</p>
        <PairingForm />
        <RunHereSwitch />
      </div>
    </Welcome>
  </section>;
};
