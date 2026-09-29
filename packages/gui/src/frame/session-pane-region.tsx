import { Composer } from "../composer/composer.js";
import { SlashCommands } from "../composer/slash-commands.js";
import { PromptCard } from "../prompt-card/prompt-card.js";
import { QueueStrip } from "../queue/queued.js";
import { SessionQueueProvider } from "../queue/session-queue.js";
import { RewoundStrip } from "../fork-rewind/rewound.js";
import { SessionForkRewindProvider } from "../fork-rewind/session-fork-rewind.js";
import { PaneLine, PaneLines } from "../session/pane-line.js";
import { SideColumnView } from "../side-column/side-column.js";
import { PaneDialogs } from "../status/pane-dialogs.js";
import { StatusLine } from "../status/status-line.js";
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
 * turns, the strip over the composer that counts them, the parked prompt's
 * card, the composer and the status line under it, with the dialogs its
 * pickers open (the sign-in card, the hand-off picker), and its fork and
 * rewind for what offers them: the actions under each message, the rewound
 * fold and the rewound strip over the composer (#403); and beside it the session's side column ("The
 * seven panes and the grid"), whose refusals are said on the pane's line and
 * whose panes the pane's slash commands open. Another session opened in the
 * pane brings its own column, and its own line, or the line handed to it.
 */
export const SessionPaneRegion = () => {
  const [layout] = usePresentation("paneLayout");
  const { session } = layout;
  return (
    <PaneLines>
      <main className="flex h-full min-w-0 flex-col bg-abyss">
        {session === null ? (
        <NoSessionOpen />
      ) : (
        <div className="flex min-h-0 flex-1">
          <PaneLine key={`${session.environmentId} ${session.sessionId}`} environmentId={session.environmentId} sessionId={session.sessionId}>
            <SessionQueueProvider environmentId={session.environmentId} sessionId={session.sessionId}>
              <SlashCommands>
                <PaneDialogs environmentId={session.environmentId} sessionId={session.sessionId}>
                  <SessionForkRewindProvider environmentId={session.environmentId} sessionId={session.sessionId}>
                    <section aria-label="Session pane" className="flex min-h-0 min-w-0 flex-1 flex-col">
                      <Transcript environmentId={session.environmentId} sessionId={session.sessionId} />
                      <QueueStrip />
                      <PromptCard environmentId={session.environmentId} sessionId={session.sessionId} />
                      <RewoundStrip />
                      <Composer environmentId={session.environmentId} sessionId={session.sessionId} />
                      <StatusLine environmentId={session.environmentId} sessionId={session.sessionId} />
                    </section>
                    <SideColumnView environmentId={session.environmentId} sessionId={session.sessionId} />
                  </SessionForkRewindProvider>
                </PaneDialogs>
              </SlashCommands>
            </SessionQueueProvider>
          </PaneLine>
        </div>
      )}
      </main>
    </PaneLines>
  );
};
