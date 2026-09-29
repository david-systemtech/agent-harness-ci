import { Composer } from "../composer/composer.js";
import { SlashCommands } from "../composer/slash-commands.js";
import { PromptCard } from "../prompt-card/prompt-card.js";
import { QueueStrip } from "../queue/queued.js";
import { SessionQueueProvider } from "../queue/session-queue.js";
import { PaneLine } from "../session/pane-line.js";
import { Transcript } from "../transcript/transcript.js";
import { usePresentation } from "../window-context.js";

/**
 * The session pane region (docs/specs/gui.md, "A session pane"): one session
 * pane, showing the session presentation holds for it (`paneLayout`), or
 * saying none is open. The pane holds its one line and its session's queue
 * for what it draws: the transcript with the queued messages after their
 * turns, the strip over the composer that counts them, the parked prompt's
 * card, and the composer.
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
          <PaneLine key={`${session.environmentId} ${session.sessionId}`}>
            <SessionQueueProvider environmentId={session.environmentId} sessionId={session.sessionId}>
              <SlashCommands>
                <Transcript environmentId={session.environmentId} sessionId={session.sessionId} />
                <QueueStrip />
                <PromptCard environmentId={session.environmentId} sessionId={session.sessionId} />
                <Composer environmentId={session.environmentId} sessionId={session.sessionId} />
              </SlashCommands>
            </SessionQueueProvider>
          </PaneLine>
        </section>
      )}
    </main>
  );
};
