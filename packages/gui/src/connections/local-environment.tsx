import { useClock } from "../window-context.js";
import type { EnvironmentView } from "@agent-harness/client-runtime";
import { Link, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { useKeyMap, useMacOS } from "../keys/key-dispatch.js";
import type { KeyMap } from "../keys/key-map.js";
import { Welcome } from "../session/empty-state.js";
import { Alert, AlertDescription, AlertTitle, Button, Tooltip } from "../ui/index.js";
import { useLocalService } from "./local-service.js";
import { useOpenPairing } from "./pairing.js";
import { Remedy } from "./remedy.js";
import { RunHereSwitch } from "./run-here.js";
import { ImmediateUpdate } from "./update-progress.js";
import { phaseSentence } from "./words.js";

/** Shared service card, including the gallery's deterministic failed-start state. */
export const LocalStartCard = ({ sentence, children, keyMap, macOS }: {
  readonly sentence: string;
  readonly children: ReactNode;
  readonly keyMap?: KeyMap;
  readonly macOS?: boolean;
}) => <Welcome {...(keyMap !== undefined && { keyMap })} {...(macOS !== undefined && { macOS })}>
  <Alert className="w-full text-left">
    <TriangleAlert aria-hidden="true" className="text-amber" />
    <AlertTitle>Not ready to run</AlertTitle>
    <AlertDescription className="flex flex-col gap-3">
      <p role="status">{sentence}</p>
      {children}
    </AlertDescription>
  </Alert>
</Welcome>;

/** This machine's service while no environment is ready, with a readable cause and remedies. */
export const LocalEnvironmentPane = ({ view }: { readonly view: EnvironmentView }) => {
  const clock = useClock();
  const service = useLocalService();
  const openPairing = useOpenPairing();
  const keyMap = useKeyMap();
  const macOS = useMacOS();
  const failed = view.phase === "service-down" && !service.starting && service.failure !== undefined;
  return <section aria-label="This machine" className="flex min-h-0 flex-1 flex-col overflow-auto">
    <LocalStartCard keyMap={keyMap} macOS={macOS} sentence={failed ? `The environment on this machine did not start: ${service.failure?.text}` : phaseSentence(view, service.starting, service.installing, clock.now())}>
      <div className="flex flex-wrap items-center gap-2">
        <ImmediateUpdate view={view} />
        <Remedy view={view} startLabel={failed ? "Try again" : "Start it"} />
        <Tooltip content="Pair instead"><Button variant="outline" onClick={() => openPairing()}><Link aria-hidden="true" />Pair instead</Button></Tooltip>
      </div>
      <RunHereSwitch />
    </LocalStartCard>
  </section>;
};
