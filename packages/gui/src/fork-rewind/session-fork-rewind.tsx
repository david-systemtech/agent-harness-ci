import {
  forkAsked,
  liveRunIdOf,
  messageBack,
  oneLine,
  rewindAsked,
  stopFirstOffer,
  tooFarBack,
  userMessagesOf,
  type RewindAnswer,
  type RewoundAt,
  type VerbAvailability,
} from "@agent-harness/client-runtime";
import { createContext, use, useMemo, useRef, type ReactNode } from "react";
import { useSlashCommand } from "../composer/slash-commands.js";
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
 *
 * It wires `/fork [n]` and `/rewind [n | undo]` too (#665), counting back
 * and read as the terminal UI reads them (the runtime's `forkAsked`,
 * `rewindAsked` and `messageBack`): `/rewind` one prompt back, `/rewind n`,
 * `/rewind undo`; bare `/fork` the whole session, the fork opening on its
 * forked row, and `/fork n`. Typed at the composer, they say their lines on
 * the pane's line, where they were asked. A typed rewind never stops a run:
 * nothing it shows said it would, so while a run is live it is refused with
 * the runtime's reason, and "Stop and rewind here" under the message is the
 * stop.
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

/** Says a line where what it is about was asked, or clears it (undefined). */
type Tell = (line: string | undefined) => void;

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
  /**
   * Starts `work` unless one of its kind is on its way, when the press does nothing at all: the line saying what the first
   * waits for stays. Started, the pane's line is cleared first, as a new action's is.
   */
  const once = (what: "fork" | "rewind" | "undo", work: () => Promise<void>) => {
    if (underWay.current.has(what)) return;
    underWay.current.add(what);
    say(undefined);
    void work().finally(() => underWay.current.delete(what));
  };

  // The rewind as the runtime offers it now: a stop first while the live run can be stopped for it, else why not.
  const offer = stopFirstOffer(runs, liveRunIdOf(projection, runs));
  const stops = offer.stops !== null;

  /** Says a line under `message`: where a press about it says what came of it. */
  const underMessage =
    (message: MessageAnchor): Tell =>
    (line) =>
      sayUnder(message.messageId, line);

  /** What a rewind to `message` answered: nothing to say once it is done, else one line (`tell`), or the session it started opened. */
  const answered = (message: MessageAnchor, workspace: string | undefined, tell: Tell, done: RewindAnswer): void => {
    switch (done.kind) {
      case "new-session":
        if (!done.answer.ok) return tell(`No session was started: ${done.answer.error.message}`);
        return openInPane(
          environmentId,
          done.sessionId,
          `${messageWords(message.text)} was the first prompt, with nothing before it: a new session${workspace !== undefined ? ` in ${workspace}` : ""} starts with it as its draft.`,
        );
      case "rewind":
        return tell(done.answer.ok ? undefined : `Not rewound: ${done.answer.error.message}`);
      case "refused":
        return tell(`Not rewound: ${done.message}`);
      case "interrupt":
        return tell(`Not interrupted: ${done.answer.error.message} Nothing was rewound.`);
      case "gave-up":
        return tell("The run has not ended since the stop: not rewound. Rewind again once it has.");
    }
  };

  /** Forks the session before `message`, or (null) the whole of it, and opens the fork; `tell` says why not. */
  const fork = (message: MessageAnchor | null, tell: Tell) => {
    const verb = runs.verbs.fork;
    if (verb.status === "absent") return tell(refused("Not forked", verb));
    once("fork", async () => {
      const { sessionId: forked, answer } = await runtime.commands.fork(environmentId, sessionId, message === null ? {} : { anchor: message.messageId });
      if (!answer.ok) return tell(`Not forked: ${answer.error.message}`);
      openInPane(environmentId, forked);
    });
  };

  /** Rewinds the session to `message`, stopping the live run first when `stopFirst`, else refused with `verb`'s reason while it is absent; `tell` says what came of it. */
  const rewind = (message: MessageAnchor, tell: Tell, stopFirst: boolean, verb: VerbAvailability) => {
    if (!stopFirst && verb.status === "absent") return tell(refused("Not rewound", verb));
    const workspace = projection.summary?.workspace.path;
    once("rewind", async () => {
      const options = stopFirst ? { stopFirst: true, onStopping: () => tell(`Stopping the run; the rewind to ${messageWords(message.text)} follows once it has ended.`) } : {};
      answered(message, workspace, tell, await runtime.commands.rewind(environmentId, sessionId, message.messageId, options));
    });
  };

  const undo = () => {
    const verb = runs.verbs.undoRewind;
    if (verb.status === "absent") return say(verb.reason === "no_rewind" ? verb.message : refused("Not undone", verb));
    once("undo", async () => {
      // What this window typed goes first: the environment puts back the draft from before the rewind only while the draft is the rewind's.
      runtime.drafts.flush();
      const answer = await runtime.commands.dispatch(environmentId, "sessions.undoRewind", { sessionId });
      if (!answer.ok) say(`Not undone: ${answer.error.message}`);
    });
  };

  /** The user message `back` prompts from the end, as `/rewind n` and `/fork n` count; undefined, said on the pane's line, when there are fewer. */
  const promptBack = (back: number, verb: "rewind" | "fork from"): MessageAnchor | undefined => {
    const messages = userMessagesOf(projection.items);
    const message = messageBack(messages, back);
    if (message === undefined) say(tooFarBack(messages.length, verb));
    return message;
  };

  // A typed rewind is the runtime's verb, never a stop: offered, it is drawn from `verbs.rewind`, which is absent while a run is live.
  useSlashCommand(
    "rewind",
    (argument) => {
      const asked = rewindAsked(argument);
      if (asked.kind === "usage") return say(asked.line);
      if (asked.kind === "rewind-undo") return undo();
      const message = promptBack(asked.back, "rewind");
      if (message !== undefined) rewind(message, say, false, runs.verbs.rewind);
    },
    runs.verbs.rewind,
  );
  useSlashCommand(
    "fork",
    (argument) => {
      const asked = forkAsked(argument);
      if (asked.kind === "usage") return say(asked.line);
      if (asked.back === null) return fork(null, say);
      const message = promptBack(asked.back, "fork from");
      if (message !== undefined) fork(message, say);
    },
    runs.verbs.fork,
  );

  const forkRewind: SessionForkRewind = {
    environmentId,
    fork: runs.verbs.fork,
    rewind: stops ? { status: "present" } : offer.rewind,
    stops,
    undoRewind: runs.verbs.undoRewind,
    rewound: runs.rewound,
    forkAt(message) {
      fork(message, underMessage(message));
    },
    forkOntoAccount(message) {
      const verb = runs.verbs.fork;
      if (verb.status === "absent") return sayUnder(message.messageId, refused("Not forked", verb));
      say(undefined);
      openHandoff(message);
    },
    rewindTo(message) {
      // The stop only when the rewind was offered as one: a run gone live since the offer was drawn is not stopped unasked.
      rewind(message, underMessage(message), stops, offer.rewind);
    },
    undo,
  };
  return <ForkRewindContext value={forkRewind}>{children}</ForkRewindContext>;
};

/** The session's fork and rewind, for a part of the pane that offers them. */
export const useSessionForkRewind = (): SessionForkRewind => {
  const forkRewind = use(ForkRewindContext);
  if (forkRewind === null) throw new Error("A session's fork and rewind are offered inside its session pane, which holds them.");
  return forkRewind;
};
