import type { ChecksView } from "@agent-harness/client-runtime";
import { useMemo } from "react";
import type { Offer } from "../keys/key-dispatch.js";
import { VerbButton } from "../session/verb-button.js";
import { useObservable, useRuntime } from "../window-context.js";
import { useSlashCommand } from "./slash-commands.js";

/** Configuration and execution belong to the Environment; this surface only reads and asks. */
export const useWorkspaceChecks = (environmentId: string, sessionId: string, say: (line: string | undefined) => void): ChecksView => {
  const runtime = useRuntime();
  const view = useObservable(useMemo(() => runtime.projections.checks(environmentId, sessionId), [runtime, environmentId, sessionId]));
  useSlashCommand("check", (argument) => {
    if (view.availability.status === "absent") return say(view.availability.message);
    const form = argument.trim();
    if (form === "") {
      void runtime.checks.get(environmentId, sessionId).then((answer) => {
        runtime.requests.refresh(environmentId, "checks.get", { sessionId });
        say(!answer.ok ? answer.error.message : answer.result.command === null ? `Check is off for ${answer.result.workspace}.` : `$ ${answer.result.command}`);
      });
    } else if (form === "now") {
      void runtime.checks.run(environmentId, sessionId).then((answer) => {
        const error = !answer.ok ? answer.error : answer.result.receipt.status === "rejected" ? answer.result.receipt.error : undefined;
        say(error === undefined ? "Check running on the Environment." : `${error.data?.["reason"] ?? error.code}: ${error.message}`);
      });
    } else {
      void runtime.checks.set(environmentId, sessionId, form === "off" ? null : argument).then((answer) => {
        say(!answer.ok ? answer.error.message : answer.result.receipt.status === "rejected" ? answer.result.receipt.error.message : form === "off" ? "Check is off." : "Check saved for this Workspace.");
      });
    }
  }, view.availability);
  return view;
};

export const WorkspaceCheck = ({ view, sendFailure, sending }: { readonly view: ChecksView; readonly sendFailure: () => void; readonly sending: Offer }) => (
  <section aria-label="Workspace check" className="text-xs text-ink-muted">
    {view.availability.status === "absent" ? <p className="text-ink-faint">{view.availability.message}</p> : view.value === null ? <p>{view.error?.message ?? "Reading Workspace check…"}</p> : (
      <>
        <p>{view.value.workspace}</p>
        {view.value.command === null ? <p>Check is off.</p> : <pre className="whitespace-pre-wrap break-words">{`$ ${view.value.command}`}</pre>}
      </>
    )}
    {view.offer !== null && <VerbButton does="Send the offered check output to the agent" availability={sending} run={sendFailure}>Send failure</VerbButton>}
  </section>
);
