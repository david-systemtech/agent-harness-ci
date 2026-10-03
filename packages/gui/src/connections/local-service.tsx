import { LOCAL_PLACEHOLDER_ID, type CapabilityAnswer } from "@agent-harness/client-runtime";
import { createContext, use, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { desktopErrorMessage } from "../platform/desktop-platform.js";
import { useObservable, usePresentation, useRuntime, useShell } from "../window-context.js";

/**
 * This machine's environment's service, as the window starts it
 * (docs/specs/gui.md, "The local environment, pairing and updates"):
 * `connections.startService`, whose shell `service` installs the service
 * from the artefact the desktop carries when none is installed and starts
 * it. On first launch, while "Run an environment on this machine" is on,
 * the window starts it once for the placeholder the runtime lists for an
 * environment never seen (#181); afterwards a service that is down is
 * offered a start, never started unasked. Before starting, the window asks
 * the shell whether it must install, and shows that step until it settles.
 * The start under way and why the last one failed are the window's, shared
 * by every place that offers it.
 */

export interface LocalService {
  /** Whether the shell can install and start a service at all (absent in a browser tab), with the line that says why not. */
  readonly available: CapabilityAnswer;
  /** Whether a start asked from this window is under way. */
  readonly starting: boolean;
  /** Whether the first install is under way, before the service can start. */
  readonly installing: boolean;
  /** Why the last start asked from this window failed, until another is asked. */
  readonly failure: string | undefined;
  /** Starts the service of the local environment listed as `environmentId`. */
  start(environmentId: string): void;
}

const LocalServiceContext = createContext<LocalService | null>(null);

export const LocalServiceProvider = ({ children }: { readonly children: ReactNode }) => {
  const runtime = useRuntime();
  const shell = useShell();
  const environments = useObservable(runtime.projections.environments);
  const [runHere] = usePresentation("runLocalEnvironment");
  const [starting, setStarting] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const available = runtime.capability(LOCAL_PLACEHOLDER_ID, "shell.service");

  /** Whether this window has started the service yet, asked or on first launch: first launch starts it only when it has not. */
  const started = useRef(false);
  const start = useCallback(
    (environmentId: string) => {
      started.current = true;
      setStarting(true);
      setFailure(undefined);
      const run = async () => {
        if (available.status === "present" && shell?.service !== undefined && !(await shell.service.status()).installed) {
          setInstalling(true);
          await shell.service.install();
          setInstalling(false);
        }
        await runtime.connections.startService(environmentId);
      };
      run().then(
        () => setStarting(false),
        (error: unknown) => {
          setStarting(false);
          setInstalling(false);
          setFailure(desktopErrorMessage(error));
        },
      );
    },
    [runtime, shell, available.status],
  );

  // First launch: the placeholder for an environment never seen, its service down, started once per window while the preference is on.
  const placeholderDown = environments.some((view) => view.environmentId === LOCAL_PLACEHOLDER_ID && view.phase === "service-down");
  useEffect(() => {
    if (!started.current && runHere && placeholderDown && available.status === "present") start(LOCAL_PLACEHOLDER_ID);
  }, [runHere, placeholderDown, available.status, start]);

  const value = useMemo(() => ({ available, starting, installing, failure, start }), [available, starting, installing, failure, start]);
  return <LocalServiceContext value={value}>{children}</LocalServiceContext>;
};

export const useLocalService = (): LocalService => {
  const service = use(LocalServiceContext);
  if (service === null) throw new Error("The local service is offered inside the LocalServiceProvider, which the App holds.");
  return service;
};
