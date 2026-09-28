import { Transcript } from "../transcript/transcript.js";
import { usePresentation } from "../window-context.js";

/**
 * The session pane region (docs/specs/gui.md, "A session pane"): one session
 * pane, showing the session presentation holds for it (`paneLayout`), or
 * saying none is open.
 */
export const SessionPaneRegion = () => {
  const [layout] = usePresentation("paneLayout");
  const { session } = layout;
  return (
    <main className="flex h-full min-w-0 flex-col bg-abyss">
      {session === null ? (
        <section aria-label="Session pane" className="flex flex-1 items-center justify-center p-6">
          <p className="text-sm text-ink-faint">No session is open. Choose one from the sidebar.</p>
        </section>
      ) : (
        <section aria-label="Session pane" className="flex min-h-0 flex-1 flex-col">
          <Transcript key={`${session.environmentId} ${session.sessionId}`} environmentId={session.environmentId} sessionId={session.sessionId} />
        </section>
      )}
    </main>
  );
};
