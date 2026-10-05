import { LOCAL_PLACEHOLDER_ID } from "@agent-harness/client-runtime";
import type { ReactNode } from "react";
import { usePhoneFrame } from "../frame/phone-frame.js";
import { PromptCard } from "../prompt-card/prompt-card.js";
import { Composer } from "../composer/composer.js";
import { SlashCommands } from "../composer/slash-commands.js";
import { useLocalService } from "../connections/local-service.js";
import { LocalEnvironmentPane } from "../connections/local-environment.js";
import { PairingPane } from "../connections/pairing-pane.js";
import { SessionForkRewindProvider } from "../fork-rewind/session-fork-rewind.js";
import { NewSessionSurface } from "../new-session/surface.js";
import type { PaneNewSession, PaneSession } from "../presentation.js";
import { SessionQueueProvider } from "../queue/session-queue.js";
import { EmptyState, Welcome } from "../session/empty-state.js";
import { useKeyMap, useMacOS } from "../keys/key-dispatch.js";
import { PaneDocumentsProvider } from "../session/pane-documents.js";
import { PaneLine } from "../session/pane-line.js";
import { SideColumnView } from "../side-column/side-column.js";
import { PaneOrganising } from "../sidebar/pane-organising.js";
import { TrustQuestion } from "../skills/trust.js";
import { PaneDialogs } from "../status/pane-dialogs.js";
import { StatusLine } from "../status/status-line.js";
import { COLUMN_WIDTHS, Transcript } from "../transcript/transcript.js";
import { useObservable, usePresentation, useRuntime, useShell } from "../window-context.js";
import { EmptyCaption, NewSessionCaption, SessionCaption, type CaptionProps } from "./caption.js";

/** What a pane's contents take from the grid: whether it is the focused pane, marked, and its close. */
export interface PaneContentsProps extends CaptionProps {
  readonly focused: boolean;
}

/**
 * A session pane (docs/specs/gui.md, "A session pane"): its caption, and the
 * session it shows. The pane holds its one line and its session's queue for
 * what it draws: the transcript with the queued messages after their turns,
 * the strip over the composer that counts them, the parked prompt's card,
 * the composer and the status line under it, with the dialogs its pickers
 * open (the sign-in card, the hand-off picker), and its fork and rewind for
 * what offers them: the actions under each message, the rewound fold and the
 * rewound strip over the composer (#403); and beside it the session's side
 * column ("The seven panes and the grid"), whose refusals are said on the
 * pane's line and whose panes the pane's slash commands open; and its
 * organising slash commands, with the sidebar's dialogs they open (#753). It
 * holds what its documents are asked (the Preview's document, the call the transcript
 * shows), which the transcript and the column both ask. Another session
 * opened in the pane brings its own column, and its own line, or the line
 * handed to it as it opened. An authoring card may supply its own header,
 * keeping the same session controls below it (#585).
 */
export const SessionPane = ({ session, focused, header, authoring = false, ...caption }: PaneContentsProps & { readonly session: PaneSession; readonly header?: ReactNode; readonly authoring?: boolean }) => {
  const { narrow } = usePhoneFrame();
  const shell = useShell();
  const { environmentId, sessionId } = session;
  const [readingWidth] = usePresentation("readingWidth");
  return (
    <div data-dock-owner className="relative flex min-h-0 min-w-0 flex-1">
      <PaneLine key={`${environmentId} ${sessionId}`} environmentId={environmentId} sessionId={sessionId}>
        <PaneDocumentsProvider session={session}>
          <SessionQueueProvider environmentId={environmentId} sessionId={sessionId}>
            <SlashCommands>
              <PaneDialogs environmentId={environmentId} sessionId={sessionId}>
                <SessionForkRewindProvider environmentId={environmentId} sessionId={sessionId}>
                  <section aria-label="Session pane" aria-current={focused ? "true" : undefined} className="flex min-h-0 min-w-0 flex-1 flex-col">
                    {header ?? <SessionCaption session={session} {...caption} />}
                    <TrustQuestion environmentId={environmentId} sessionId={sessionId} />
                    <Transcript environmentId={environmentId} sessionId={sessionId} />
                    {authoring && <div data-prompt-column className="mx-auto flex min-h-0 w-full shrink flex-col" style={{ maxWidth: COLUMN_WIDTHS[readingWidth] }}>
                      <PromptCard environmentId={environmentId} sessionId={sessionId} />
                    </div>}
                    <div data-composer-column className="mx-auto w-full shrink-0" style={{ maxWidth: COLUMN_WIDTHS[readingWidth] }}>
                      <Composer environmentId={environmentId} sessionId={sessionId} authoring={authoring} />
                      {!authoring && (shell !== undefined || !narrow) && <StatusLine environmentId={environmentId} sessionId={sessionId} />}
                    </div>
                  </section>
                  <SideColumnView environmentId={environmentId} sessionId={sessionId} />
                  <PaneOrganising environmentId={environmentId} sessionId={sessionId} />
                </SessionForkRewindProvider>
              </PaneDialogs>
            </SlashCommands>
          </SessionQueueProvider>
        </PaneDocumentsProvider>
      </PaneLine>
    </div>
  );
};

/**
 * A pane holding the new-session surface (docs/specs/gui.md, "A new
 * session"; #420) until its first send: its caption, and the surface.
 */
export const NewSessionPane = ({ focused, surface, ...caption }: PaneContentsProps & { readonly surface: PaneNewSession }) => (
  <section aria-label="Session pane" aria-current={focused ? "true" : undefined} className="flex min-h-0 flex-1 flex-col">
    <NewSessionCaption {...caption} />
    <NewSessionSurface key={surface.id} surface={surface} />
  </section>
);

/**
 * A pane with no session open (docs/specs/gui.md, "The local environment,
 * pairing and updates"): while no environment is ready, what the window
 * waits on, this machine's environment while "Run an environment on this
 * machine" is on, else pairing when nothing is paired; once one is ready, a
 * word to choose a session. Its caption, and close with it, whichever it
 * shows.
 */
export const EmptyPane = ({ focused, ...caption }: PaneContentsProps) => (
  <section aria-label="Session pane" aria-current={focused ? "true" : undefined} className="flex min-h-0 flex-1 flex-col">
    <EmptyCaption {...caption} />
    <NoSessionOpen />
  </section>
);

/** What a pane with no session shows under its caption. */
const NoSessionOpen = () => {
  const environments = useObservable(useRuntime().projections.environments);
  const [runHere] = usePresentation("runLocalEnvironment");
  const keyMap = useKeyMap();
  const macOS = useMacOS();
  const service = useLocalService();
  const local = environments.find((view) => view.kind === "local");
  const known = environments.filter((view) => view.environmentId !== LOCAL_PLACEHOLDER_ID);
  if (!environments.some((view) => view.phase === "ready")) {
    if (runHere) {
      if (local !== undefined) return <LocalEnvironmentPane view={local} />;
      if (service.available.status === "present") return <Welcome keyMap={keyMap} macOS={macOS}><p role="status" className="text-sm text-ink-muted">Starting…</p></Welcome>;
    }
    if (!known.some((view) => view.kind === "paired")) return <PairingPane />;
  }
  return <EmptyState />;
};
