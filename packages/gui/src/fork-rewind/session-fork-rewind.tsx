import { liveRunIdOf, oneLine, stopFirstOffer, type RewindAnswer, type RewoundAt, type VerbAvailability } from "@agent-harness/client-runtime";
import { createContext, use, useMemo, useRef, type ReactNode } from "react";
import { useOpenInPane, usePaneLine, useSayUnder } from "../session/pane-line.js";
import { useHandoffPicker, type MessageAnchor } from "../status/pane-dialogs.js";
import { useObservable, useRuntime } from "../window-context.js";

/**
 * A session's fork and rewind in its pane (docs/specs/gui.md, "A session
 * pane"; ADR 0022; #403), for everything in the pane that offers them: the
 * actions under each user message a run has read, the rewound fold and the
 * rewound strip over the composer. Each verb stands as the runtime says
 * (`projections.runs.session`'s verbs), so the window and the terminal UI
 * offer the same:
 *
 * - **Fork** is `commands.fork` anchored at the message; the fork, holding
 *   the conversation before it with the message as its draft, opens in the
 *   pane once the environment accepts it. **Fork onto another account**
 *   opens the hand-off picker anchored at the message.
 * - **Rewind** is `commands.rewind`. While a run is live and can be stopped
 *   for it (`stopFirstOffer`: nothing queued, the run past starting) it is
 *   offered as "Stop and rewind here", the runtime's stop-first rewind; with
 *   messages queued it stays dim, saying to withdraw them first. A rewind to
 *   the session's first message is the runtime's to turn into a new session
 *   (`use_new_session`), which opens in the pane, saying why.
 * - **Undo rewind** is `sessions.undoRewind`, this window's waiting draft
 *   sent first, while the latest rewind can still be undone.
 *
 * A verb the runtime says cannot be used now dispatches nothing and says its
 * reason in one line; what the environment refuses is one line too: under
 * the message for a fork or a rewind, on the pane's line for an undo. One of
 * each is on its way from the pane at a time.
 */
export interface SessionForkRewind {
  readonly environmentId: string;
  /** `verbs.fork`: both forks. */
  readonly fork: VerbAvailability;
  /** The rewind as it is offered now: present while it is a stop and a rewind (`stops`); else the runtime's, except while a run is live, when it says why no stop can be had. */
  readonly rewind: VerbAvailability;
  /** The rewind is offered as "Stop and rewind here": a run is live, one that can be stopped, and nothing is queued behind it. */
  readonly stops: boolean;
  /** `verbs.undoRewind`. */
  readonly undoRewind: VerbAvailability;
  /** The latest rewind standing, which the fold and the strip offer to undo while it is `undoable`. */
  readonly rewound: RewoundAt | null;
  /** Forks the session before `message`, and opens the fork. */
  forkAt(message: MessageAnchor): void;
  /** Opens the hand-off picker anchored at `message`. */
  forkOntoAccount(message: MessageAnchor): void;
  /** Rewinds the session to `message`, stopping the live run first while the rewind is offered so. */
  rewindTo(message: MessageAnchor): void;
  /** Undoes the latest rewind. */
  undo(): void;
}

const ForkRewindContext = createContext<SessionForkRewind | null>(null);

/** A user message as a line names it: its first line, cut. */
export const messageWords = (text: string): string => oneLine(text, 80);

/** What was not done and why, in one line: "Not forked: <the reason>". */
const refused = (what: string, verb: Extract<VerbAvailability, { status: "absent" }>): string => `${what}: ${verb.message}`;

export interface SessionForkRewindProps {
  readonly environmentId: string;
  readonly sessionId: string;
  readonly children: ReactNode;
}

/** The session's fork and rewind for the pane it holds. */
export const SessionForkRewindProvider = ({ environmentId, sessionId, children }: SessionForkRewindProps) => {
  const runtime = useRuntime();
  const projection = useObservable(useMemo(() => runtime.projections.session(environmentId, sessionId), [runtime, environmentId, sessionId]));
  const runs = useObservable(useMemo(() => runtime.projections.runs.session(environmentId, sessionId), [runtime, environmentId, sessionId]));
  const [, say] = usePaneLine();
  const sayUnder = useSayUnder();
  const openHandoff = useHandoffPicker();
  const openInPane = useOpenInPane();
  // What this pane has on its way: a second of each meanwhile would only fork twice, or be refused.
  const underWay = useRef(new Set<"fork" | "rewind" | "undo">());
  const once = (what: "fork" | "rewind" | "undo", work: () => Promise<void>) => {
    if (underWay.current.has(what)) return;
    underWay.current.add(what);
    void work().finally(() => underWay.current.delete(what));
  };

  // The rewind as the runtime offers it now: a stop first while the live run can be stopped for it, else why not.
  const offer = stopFirstOffer(runs, liveRunIdOf(projection, runs));
  const stops = offer.stops !== null;

  /** What a rewind to `message` answered: nothing to say once it is done, else one line under it, or the session it started opened. */
  const answered = (message: MessageAnchor, workspace: string | undefined, done: RewindAnswer): void => {
    const under = (line: string | undefined) => sayUnder(message.messageId, line);
    switch (done.kind) {
      case "new-session":
        if (!done.answer.ok) return under(`No session was started: ${done.answer.error.message}`);
        return openInPane(
          environmentId,
          done.sessionId,
          `${messageWords(message.text)} was the first prompt, with nothing before it: a new session${workspace !== undefined ? ` in ${workspace}` : ""} starts with it as its draft.`,
        );
      case "rewind":
        return under(done.answer.ok ? undefined : `Not rewound: ${done.answer.error.message}`);
      case "refused":
        return under(`Not rewound: ${done.message}`);
      case "interrupt":
        return under(`Not interrupted: ${done.answer.error.message} Nothing was rewound.`);
      case "gave-up":
        return under("The run has not ended since the stop: not rewound. Rewind again once it has.");
    }
  };

  const forkRewind: SessionForkRewind = {
    environmentId,
    fork: runs.verbs.fork,
    rewind: stops ? { status: "present" } : offer.rewind,
    stops,
    undoRewind: runs.verbs.undoRewind,
    rewound: runs.rewound,
    forkAt(message) {
      const verb = runs.verbs.fork;
      if (verb.status === "absent") return sayUnder(message.messageId, refused("Not forked", verb));
      say(undefined);
      once("fork", async () => {
        const { sessionId: forked, answer } = await runtime.commands.fork(environmentId, sessionId, { anchor: message.messageId });
        if (!answer.ok) return sayUnder(message.messageId, `Not forked: ${answer.error.message}`);
        openInPane(environmentId, forked);
      });
    },
    forkOntoAccount(message) {
      const verb = runs.verbs.fork;
      if (verb.status === "absent") return sayUnder(message.messageId, refused("Not forked", verb));
      say(undefined);
      openHandoff(message);
    },
    rewindTo(message) {
      if (!stops && offer.rewind.status === "absent") return sayUnder(message.messageId, refused("Not rewound", offer.rewind));
      const workspace = projection.summary?.workspace.path;
      say(undefined);
      once("rewind", async () => {
        // The stop only when the rewind was offered as one: a run gone live since the offer was drawn is not stopped unasked.
        const options = stops
          ? { stopFirst: true, onStopping: () => sayUnder(message.messageId, `Stopping the run; the rewind to ${messageWords(message.text)} follows once it has ended.`) }
          : {};
        answered(message, workspace, await runtime.commands.rewind(environmentId, sessionId, message.messageId, options));
      });
    },
    undo() {
      const verb = runs.verbs.undoRewind;
      if (verb.status === "absent") return say(verb.reason === "no_rewind" ? verb.message : refused("Not undone", verb));
      say(undefined);
      once("undo", async () => {
        // What this window typed goes first: the environment puts back the draft from before the rewind only while the draft is the rewind's.
        runtime.drafts.flush();
        const answer = await runtime.commands.dispatch(environmentId, "sessions.undoRewind", { sessionId });
        if (!answer.ok) say(`Not undone: ${answer.error.message}`);
      });
    },
  };
  return <ForkRewindContext value={forkRewind}>{children}</ForkRewindContext>;
};

/** The session's fork and rewind, for a part of the pane that offers them. */
export const useSessionForkRewind = (): SessionForkRewind => {
  const forkRewind = use(ForkRewindContext);
  if (forkRewind === null) throw new Error("A session's fork and rewind are offered inside its session pane, which holds them.");
  return forkRewind;
};
