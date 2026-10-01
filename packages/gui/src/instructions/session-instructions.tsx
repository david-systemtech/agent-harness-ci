import { useMemo, useState } from "react";
import type { SessionProjection } from "@agent-harness/client-runtime";
import { Button, Dialog, DialogContent } from "../ui/index.js";
import { useObservable, useRuntime } from "../window-context.js";
import { MarkdownField } from "./instruction-editor.js";

export const SessionInstructionsDialog = ({
  environmentId,
  sessionId,
  title,
  close,
}: {
  readonly environmentId: string;
  readonly sessionId: string;
  readonly title: string;
  close(): void;
}) => {
  const runtime = useRuntime();
  const session = useObservable(useMemo(() => runtime.projections.session(environmentId, sessionId), [runtime, environmentId, sessionId]));
  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent title={`Instructions for ${title}`} description="These instructions apply from this session's next run. A run already live keeps what it began with.">
        {session.summary === null || session.freshness === "catching-up" ? (
          <p className="text-sm text-ink-muted">{session.deleted ? "This session was removed." : "Reading the session instructions…"}</p>
        ) : (
          <SessionInstructionsForm key={`${environmentId}/${sessionId}`} environmentId={environmentId} sessionId={sessionId} session={session} close={close} />
        )}
      </DialogContent>
    </Dialog>
  );
};

const SessionInstructionsForm = ({
  environmentId,
  sessionId,
  session,
  close,
}: {
  readonly environmentId: string;
  readonly sessionId: string;
  readonly session: SessionProjection;
  close(): void;
}) => {
  const runtime = useRuntime();
  const [text, type] = useState(session.instructions);
  const [line, say] = useState<string | undefined>(undefined);
  const [sending, setSending] = useState(false);
  const offer = runtime.commands.admits(environmentId, "sessions.setInstructions");
  const writable = offer.status === "present" && session.freshness === "live" && !sending;
  const save = async (next: string) => {
    say(undefined);
    setSending(true);
    try {
      const answer = await runtime.commands.dispatch(environmentId, "sessions.setInstructions", { sessionId, text: next });
      if (answer.ok) close();
      else say(`Not saved: ${answer.error.message}`);
    } finally {
      setSending(false);
    }
  };
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (writable) void save(text);
      }}
    >
      <MarkdownField value={text} change={type} disabled={!writable} />
      {offer.status === "absent" && <p className="text-xs text-ink-faint">{offer.message}</p>}
      {session.freshness !== "live" && <p className="text-sm text-amber">Cached session instructions, stale; read-only until the session is live.</p>}
      {line !== undefined && (
        <p role="status" className="text-sm text-signal">
          {line}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button onClick={close}>Cancel</Button>
        <Button disabled={!writable} onClick={() => void save("")}>
          Clear session instructions
        </Button>
        <Button type="submit" disabled={!writable}>
          Save session instructions
        </Button>
      </div>
    </form>
  );
};
