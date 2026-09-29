import { Composer } from "../composer/composer.js";
import { SlashCommands } from "../composer/slash-commands.js";
import { QueueStrip } from "../queue/queued.js";
import { SessionQueueProvider } from "../queue/session-queue.js";
import { PaneLine } from "../session/pane-line.js";
import { Transcript } from "../transcript/transcript.js";
import { LOCAL_PLACEHOLDER_ID } from "@agent-harness/client-runtime";
import { LocalEnvironmentPane } from "../connections/local-environment.js";
import { PairingPane } from "../connections/pairing-pane.js";
import { useObservable, usePresentation, useRuntime } from "../window-context.js";

/**
 * The pane with no session open (docs/specs/gui.md, "The local environment,
 * pairing and updates"): while no environment is ready, what the window
 * waits on, this machine's environment while "Run an environment on this
 * machine" is on, else pairing when nothing is paired; once one is ready, a
 * word to choose a session.
 */
const NoSessionOpen = () => {
  const environments = useObservable(useRuntime().projections.environments);
  const [runHere] = usePresentation("runLocalEnvironment");
  const local = environments.find((view) => view.kind === "local");
  const known = environments.filter((view) => view.environmentId !== LOCAL_PLACEHOLDER_ID);
  if (!environments.some((view) => view.phase === "ready")) {
    if (runHere && local) return <LocalEnvironmentPane view={local} />;
    if (!known.some((view) => view.kind === "paired")) return <PairingPane />;
  }
  return (
    <section aria-label="Session pane" className="flex flex-1 items-center justify-center p-6">
      <p className="text-sm text-ink-faint">No session is open. Choose one from the sidebar.</p>
    </section>
  );
};

/**
 * The session pane region (docs/specs/gui.md, "A session pane"): one session
 * pane, showing the session presentation holds for it (`paneLayout`), or
 * saying none is open. The pane holds its one line and its session's queue
 * for what it draws: the transcript with the queued messages after their
 * turns, the strip over the composer that counts them, and the composer.
 */
export const SessionPaneRegion = () => {
  const [layout] = usePresentation("paneLayout");
  const { session } = layout;
  return (
    <main className="flex h-full min-w-0 flex-col bg-abyss">
      {session === null ? (
        <NoSessionOpen />
      ) : (
        <section aria-label="Session pane" className="flex min-h-0 flex-1 flex-col">
          <PaneLine key={`${session.environmentId} ${session.sessionId}`}>
            <SessionQueueProvider environmentId={session.environmentId} sessionId={session.sessionId}>
              <SlashCommands>
                <Transcript environmentId={session.environmentId} sessionId={session.sessionId} />
                <QueueStrip />
                <Composer environmentId={session.environmentId} sessionId={session.sessionId} />
              </SlashCommands>
            </SessionQueueProvider>
          </PaneLine>
        </section>
      )}
    </main>
  );
};
