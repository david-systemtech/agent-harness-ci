import { LOCAL_PLACEHOLDER_ID, serviceFailureOf, type CapabilityAnswer, type ServiceFailure, type ServiceFailureKind } from "@agent-harness/client-runtime";
import { createContext, use, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { desktopErrorMessage } from "../platform/desktop-platform.js";
import { useObservable, usePresentation, useRuntime, useShell } from "../window-context.js";

/**
 * This machine's environment's service, as the window starts it
 * (docs/specs/gui.md, "The local environment, pairing and updates"):
 * `connections.startService`, whose shell `service` installs the service
 * from the artefact the desktop carries when none is installed and starts
 * it. While "Run an environment on this machine" is on, the window
 * starts it once for the placeholder the runtime lists for an environment
 * never seen (#181), or a known one on an unfinished first launch;
 * afterwards a service that is down is
 * offered a start, never started unasked. Before starting, the window asks
 * the shell whether it must install, and shows that step until it settles.
 * The start under way and why the last one failed are the window's, shared
 * by every place that offers it. A failure keeps the kind the desktop gave
 * it, else the kind of the step that failed (setup-copy.md §4.1).
 */

export interface LocalService {
  /** Whether the shell can install and start a service at all (absent in a browser tab), with the line that says why not. */
  readonly available: CapabilityAnswer;
  /** Whether a start asked from this window is under way. */
  readonly starting: boolean;
  /** Whether the first install is under way, before the service can start. */
  readonly installing: boolean;
  /** Why the last start asked from this window failed, until another is asked. */
  readonly failure: ServiceFailure | undefined;
  /** Starts the service of the local environment listed as `environmentId`. */
  start(environmentId: string): void;
}

const LocalServiceContext = createContext<LocalService | null>(null);

export const LocalServiceProvider = ({ children }: { readonly children: ReactNode }) => {
  const runtime = useRuntime();
  const shell = useShell();
  const environments = useObservable(runtime.projections.environments);
  const [runHere] = usePresentation("runLocalEnvironment");
  const [marked] = usePresentation("firstLaunchDone");
  const [starting, setStarting] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [failure, setFailure] = useState<ServiceFailure | undefined>(undefined);
  const available = runtime.capability(LOCAL_PLACEHOLDER_ID, "shell.service");

  /** Whether this window attempted startup or found the local environment already ready: later outages wait for an action. */
  const started = useRef(false);
  const inFlight = useRef(false);
  const start = useCallback(
    (environmentId: string) => {
      if (inFlight.current) return;
      inFlight.current = true;
      started.current = true;
      setStarting(true);
      setFailure(undefined);
      let step: ServiceFailureKind = "start";
      const run = async () => {
        if (available.status === "present" && shell?.service !== undefined) {
          step = "status";
          const { installed } = await shell.service.status();
          if (!installed) {
            step = "install";
            setInstalling(true);
            await shell.service.install();
            setInstalling(false);
          }
        }
        step = "start";
        await runtime.connections.startService(environmentId);
      };
      run().then(
        () => { inFlight.current = false; setStarting(false); },
        (error: unknown) => {
          inFlight.current = false;
          setStarting(false);
          setInstalling(false);
          setFailure(serviceFailureOf(error) ?? { kind: step, text: desktopErrorMessage(error) });
        },
      );
    },
    [runtime, shell, available.status],
  );

  // Start once for a new machine or an unfinished first launch; known environments on later launches wait for an action.
  const localDown = environments.find((view) => view.kind === "local" && view.phase === "service-down" && (view.environmentId === LOCAL_PLACEHOLDER_ID || !marked));
  const startId = localDown?.environmentId;
  const localReady = environments.some((view) => view.kind === "local" && view.phase === "ready");
  useEffect(() => {
    if (localReady) started.current = true;
    if (!started.current && runHere && startId !== undefined && available.status === "present") start(startId);
  }, [runHere, startId, localReady, available.status, start]);

  const value = useMemo(() => ({ available, starting, installing, failure, start }), [available, starting, installing, failure, start]);
  return <LocalServiceContext value={value}>{children}</LocalServiceContext>;
};

export const useLocalService = (): LocalService => {
  const service = use(LocalServiceContext);
  if (service === null) throw new Error("The local service is offered inside the LocalServiceProvider, which the App holds.");
  return service;
};
