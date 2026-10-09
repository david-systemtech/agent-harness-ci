import { drainEnvironment, uuidv7, type EnvironmentView } from "@agent-harness/client-runtime";
import { useEffect, useState, type ReactNode } from "react";
import { useWindowFrame } from "../frame/window-controls.js";
import { SetupNotice } from "../setup/notice.js";
import { useClientVersion, useClock, useRuntime, useShell } from "../window-context.js";
import { useLocalService } from "./local-service.js";
import { nameOf } from "./words.js";

/** A desktop service restart, shared by the setup cards; absent for paired computers and the web. */
export interface ServiceRestart {
  readonly restarting: boolean;
  readonly disabled: boolean;
  readonly start: () => void;
  readonly failure: ReactNode;
}

/** Where a restart from this app stands: the drain asked, then the start once the service stopped. */
type RestartProgress = "idle" | "draining" | "starting";

/** What stopped a restart: the drain, refused while the computer still runs, or the start once it had stopped. */
interface RestartRefusal {
  readonly step: "drain" | "start";
  readonly text: string;
}

/**
 * Restart agent-harness (setup-copy.md §5.4 and §5.12), where the computer's service
 * can restart from this app: this computer's own, with a shell that starts
 * its service, and `environment.drain` admitted. It drains the environment,
 * which stops once its running work finishes, then starts the service as
 * Start does once nothing answers, and reads how it is reached again at its
 * start. Undefined for any other computer, whose next start uses what it found.
 */
export const useServiceRestart = (view: EnvironmentView | undefined, onRestarted?: () => void): ServiceRestart | undefined => {
  const runtime = useRuntime();
  const clock = useClock();
  const service = useLocalService();
  const shell = useShell();
  const version = useClientVersion();
  const frame = useWindowFrame();
  const [progress, setProgress] = useState<RestartProgress>("idle");
  const [refusal, setRefusal] = useState<RestartRefusal | undefined>(undefined);
  const environmentId = view?.environmentId;
  const phase = view?.phase;
  const name = view === undefined ? "this computer" : nameOf(view);
  useEffect(() => {
    if (environmentId === undefined) return;
    if (progress === "draining" && phase === "service-down") {
      setProgress("starting");
      service.start(environmentId);
    }
    if (progress === "starting" && phase === "ready") {
      setProgress("idle");
      runtime.requests.refresh(environmentId, "environment.status", {});
      onRestarted?.();
    }
  }, [progress, phase, environmentId, service, runtime, onRestarted]);
  // The start clears the last failure as it sets starting, in the render that sets starting here, so a failure
  // once it is no longer starting is this start's, however soon it fails.
  useEffect(() => {
    if (progress === "starting" && !service.starting && service.failure !== undefined) {
      setProgress("idle");
      setRefusal({ step: "start", text: service.failure.text });
    }
  }, [progress, service.starting, service.failure]);
  // A failed start is over once the computer runs again, however it was started.
  useEffect(() => {
    if (phase === "ready") setRefusal((last) => (last?.step === "start" ? undefined : last));
  }, [phase]);
  const can = view?.kind === "local" && service.available.status === "present" && runtime.capability(view.environmentId, "environment.drain").status === "present";
  // A restart under way, or its refusal, outlasts the drain that makes the computer stop answering.
  if (!can && progress === "idle" && refusal === undefined) return undefined;
  const start = () => {
    if (!can || progress !== "idle" || environmentId === undefined) return;
    setRefusal(undefined);
    setProgress("draining");
    void drainEnvironment(runtime, environmentId, name, uuidv7(clock.now())).then((outcome) => {
      if (outcome.ok) return;
      setProgress("idle");
      setRefusal({ step: "drain", text: outcome.line });
    });
  };
  const title = `agent-harness did not restart on ${name}.`;
  // Stopped and not started again, nothing answers to drain: Start, which the checklist offers then, starts it.
  const retry = refusal?.step === "start" ? "Choose Start to try again." : "Choose Restart agent-harness to try again.";
  const failure = refusal === undefined ? undefined : (
    <SetupNotice
      tone="error"
      title={title}
      description={retry}
      details={{
        report: { app: { version, platform: frame?.platform ?? "unknown" }, computer: { name }, line: `${title} ${retry}`, details: [refusal.text] },
        copy: (text) => (shell?.clipboard === undefined ? Promise.reject(new Error("This app has no clipboard.")) : shell.clipboard.writeText(text)),
      }}
    />
  );
  return { restarting: progress !== "idle", disabled: !can || progress !== "idle", start, failure };
};
