import { useEffect, useRef, useState } from "react";
import {
  interruptRun,
  oneLine,
  type Clock,
  type Runtime,
  type SessionProjection,
  type SessionRunsView,
  type TranscriptEntry,
  type UserMessageEntry,
  type VerbAvailability,
} from "@agent-harness/client-runtime";
import type { Question } from "../view.js";
import type { Opened } from "./use-session.js";

/**
 * Fork and rewind from the terminal (docs/specs/tui.md, "The transcript";
 * ADR 0022; #232): what the prompt picker, `/rewind`, `/fork`, the row verbs
 * `w`, `f` and `u` and the rewound strip dispatch, through the runtime. Each
 * verb stands as `projections.runs.session` says (`verbs`), so a verb that
 * cannot be used now is refused at once with the runtime's one line and
 * dispatches nothing; what the environment refuses is one line with its
 * message. A rewind the runtime says is refused because a run is live
 * (`run_active`), or one the environment refuses so, is offered as stop and
 * rewind: `runs.interrupt`, then, once that run has ended, `sessions.rewind`,
 * two commands, as the wire has no stop-and-rewind of its own. It is not
 * offered while messages are queued (the stop would leave them for the
 * rewind to be refused over), nor while the run is starting and there is
 * no run to stop yet. A rewind to the session's first user message is
 * `commands.rewind`'s to turn into a new session (`use_new_session`), which
 * is opened. A fork is opened once the environment has it, holding the
 * anchored message as its draft; `/handoff` on it moves its next run to
 * another account, carrying the draft (`carriedDraft`).
 */

/** The user messages the picker lists and `/rewind n` and `/fork n` count back through: those a run has read, in the visible transcript, oldest first. */
export const userMessagesOf = (items: readonly TranscriptEntry[]): readonly UserMessageEntry[] =>
  items.filter((entry): entry is UserMessageEntry => entry.kind === "user-message" && entry.delivery !== "queued");

/** The user message `back` messages from the end (1: the latest); undefined when there are fewer. */
export const messageBack = (messages: readonly UserMessageEntry[], back: number): UserMessageEntry | undefined => (back >= 1 ? messages[messages.length - back] : undefined);

/** What `/rewind n` or `/fork n` says when there are not `n` prompts to go back through. */
export const tooFarBack = (count: number, verb: "rewind" | "fork from"): string =>
  count === 0 ? `Nothing to ${verb}: no prompt has been sent in this session yet.` : `There ${count === 1 ? "is only 1 prompt" : `are only ${count} prompts`} to go back through.`;

/** A user message as a line names it: its first line, cut. */
export const messageWords = (text: string): string => oneLine(text, 80);

/** A user message a rewind or a fork is anchored at. */
export type Anchor = Pick<UserMessageEntry, "messageId" | "text">;

/**
 * How long a stop-and-rewind waits for the run it stopped to end before it
 * gives the rewind up, saying so: a chosen default, well past the 8 s the
 * Claude adapter gives an interrupt before it forces its process down.
 */
export const STOP_WAIT_MS = 30_000;

export interface ForkRewindHost {
  readonly runtime: Runtime;
  readonly clock: Clock;
  readonly opened: Opened | null;
  readonly projection: SessionProjection | undefined;
  /** The open session's queue, rewind and verbs (`projections.runs.session`). */
  readonly runs: SessionRunsView | undefined;
  /** The run live on the open session, which a stop-and-rewind interrupts; undefined while none is, or one is only starting. */
  readonly liveRunId: string | undefined;
  say(line: string): void;
  ask(question: Question): void;
  openSession(opened: Opened): void;
  newSessionId(): string;
}

/** The verbs fork and rewind use, as they stand on the open session. */
export interface ForkRewindVerbs {
  /** The runtime's, except while a run is live: absent with the reason no stop is offered (messages queued, the run only starting). */
  readonly rewind: VerbAvailability;
  readonly fork: VerbAvailability;
  readonly undoRewind: VerbAvailability;
}

export interface ForkRewind {
  /** The verbs on the open session; undefined while no session's are known. */
  readonly verbs: ForkRewindVerbs | undefined;
  /** A rewind now is offered as a stop and a rewind: a run is live, one that can be stopped, and nothing is queued behind it. */
  readonly offersStop: boolean;
  /** A key action's (the picker's Enter, `w`) `sessions.rewind` to `message` (a new session for the first), or stop-and-rewind while a run is live. */
  rewind(message: Anchor): void;
  /** `/rewind n`: a rewind to the user message `back` from the end. */
  rewindBack(back: number): void;
  /** `sessions.fork` before `message`, or of the whole session, the fork opened. */
  fork(message: Anchor | null): void;
  /** `/fork [n]`: a fork before the user message `back` from the end, or (null) of the whole session. */
  forkBack(back: number | null): void;
  /** `sessions.undoRewind` of the latest rewind standing. */
  undo(): void;
  /**
   * The draft a hand-off of the open session carries onto its new session:
   * the session's own; else, for a fork this terminal opened at a user
   * message that no run has read yet, that message, the draft emptied to
   * type `/handoff`.
   */
  carriedDraft(): string | null;
}

/** Whether an availability is the runtime's refusal because a run is live. */
export const refusedLive = (availability: VerbAvailability): boolean => availability.status === "absent" && availability.reason === "run_active";

/** Whether an availability is the connection's refusal: the environment out of reach, or not ready. */
const outOfReach = (availability: VerbAvailability | undefined): boolean =>
  availability === undefined || (availability.status === "absent" && (availability.reason === "unreachable" || availability.reason === "not-ready"));

/** Why a rewind is not offered as a stop and a rewind: what is queued would be read after the stop, and the rewind refused over it. */
const QUEUED_FIRST = "Messages are queued behind the live run: withdraw them first.";
/** Why a rewind is not offered as a stop and a rewind: the run is starting, and there is no run to stop yet. */
const STARTING = "A run is starting on this session: once it is running, a rewind offers to stop it.";

const keyOf = (opened: Opened): string => `${opened.environmentId} ${opened.sessionId}`;

export const useForkRewind = (host: ForkRewindHost): ForkRewind => {
  const { runtime, opened, runs } = host;
  const runtimeRewind = runs?.verbs.rewind;
  const queued = (runs?.queue.length ?? 0) > 0;
  const offersStop = runtimeRewind !== undefined && refusedLive(runtimeRewind) && !queued && host.liveRunId !== undefined;
  const verbs: ForkRewindVerbs | undefined =
    runs === undefined || runtimeRewind === undefined
      ? undefined
      : {
          rewind:
            refusedLive(runtimeRewind) && queued
              ? { status: "absent", reason: "queued_messages", message: QUEUED_FIRST }
              : refusedLive(runtimeRewind) && host.liveRunId === undefined
                ? { status: "absent", reason: "run_active", message: STARTING }
                : runtimeRewind,
          fork: runs.verbs.fork,
          undoRewind: runs.verbs.undoRewind,
        };
  const messages = (): readonly UserMessageEntry[] => (host.projection ? userMessagesOf(host.projection.items) : []);
  // A stop-and-rewind whose stop was accepted: the rewind waits for the run it stopped to end, on the session it was asked on.
  const [waiting, setWaiting] = useState<{ readonly target: Opened; readonly message: Anchor; readonly runId: string } | null>(null);
  // The forks this terminal opened at a user message, with its text: what a hand-off of one carries while no run has read it.
  const anchored = useRef(new Map<string, string>());
  const title = (): string => host.projection?.summary?.title ?? "this session";

  /** The open session and its verbs, or undefined, said in one line, when there is none to `verb`. */
  const sessionFor = (verb: string): { readonly target: Opened; readonly verbs: ForkRewindVerbs } | undefined => {
    if (!opened) return void host.say(`No session is open to ${verb}: /resume opens one.`);
    if (verbs === undefined) return void host.say(`The session is still loading: try to ${verb} once it shows.`);
    return { target: opened, verbs };
  };

  const stopThenRewind = (target: Opened, message: Anchor, runId: string) => {
    void interruptRun(runtime, target.environmentId, runId).then((refused) => {
      if (refused !== undefined) return host.say(`${refused} Nothing was rewound.`);
      setWaiting({ target, message, runId });
      host.say(`Stopping the run; the rewind to ${messageWords(message.text)} follows once it has ended.`);
    });
  };

  /**
   * The offer to stop the live run, then rewind. `askedByKey`: a key action
   * (the picker's Enter, `w`) asked for the rewind, so y and n answer the
   * offer whatever the composer holds; a typed `/rewind` emptied the
   * composer, and its offer, which may come once the next message is begun,
   * leaves what is typed to the composer.
   */
  const offerStop = (target: Opened, message: Anchor, runId: string | undefined, askedByKey: boolean) => {
    if (queued) return host.say(`Not rewound: ${QUEUED_FIRST}`);
    if (runId === undefined) return host.say(`Not rewound: ${STARTING}`);
    host.ask({
      text: `A run is live: stop it, then rewind to ${messageWords(message.text)}? y/n`,
      yes: () => stopThenRewind(target, message, runId),
      no: () => host.say("Not rewound: the run goes on."),
      whileTyping: askedByKey,
    });
  };

  const rewindOn = (target: Opened, message: Anchor, askedByKey: boolean) => {
    const workspace = host.projection?.summary?.workspace.path;
    // What this terminal typed goes first, so the draft the rewind writes lands after it, and an undo can put it back.
    runtime.drafts.flush();
    void runtime.commands.rewind(target.environmentId, target.sessionId, message.messageId).then((done) => {
      if (done.kind === "new-session") {
        if (!done.answer.ok) return host.say(`No session was started: ${done.answer.error.message}`);
        host.openSession({ environmentId: target.environmentId, sessionId: done.sessionId });
        return host.say(
          `${messageWords(message.text)} was the first prompt, with nothing before it: a new session${workspace !== undefined ? ` in ${workspace}` : ""} starts with it as its draft.`,
        );
      }
      const { answer } = done;
      if (answer.ok) return;
      if (answer.error.code === "conflict" && answer.error.data?.["reason"] === "run_active") {
        const runId = answer.error.data["runId"];
        return offerStop(target, message, typeof runId === "string" ? runId : undefined, askedByKey);
      }
      host.say(`Not rewound: ${answer.error.message}`);
    });
  };

  const rewindTo = (target: Opened, available: ForkRewindVerbs, message: Anchor, askedByKey: boolean) => {
    if (offersStop) return offerStop(target, message, host.liveRunId, askedByKey);
    if (available.rewind.status === "absent") return host.say(`Not rewound: ${available.rewind.message}`);
    rewindOn(target, message, askedByKey);
  };

  const forkAt = (target: Opened, available: ForkRewindVerbs, message: Anchor | null) => {
    if (available.fork.status === "absent") return host.say(`Not forked: ${available.fork.message}`);
    const { environmentId, sessionId } = target;
    const id = host.newSessionId();
    const from = title();
    void runtime.commands.dispatch(environmentId, "sessions.fork", { sessionId, id, ...(message !== null && { atMessageId: message.messageId }) }).then((answer) => {
      if (!answer.ok) return host.say(`Not forked: ${answer.error.message}`);
      if (message !== null && message.text !== "") anchored.current.set(keyOf({ environmentId, sessionId: id }), message.text);
      host.openSession({ environmentId, sessionId: id });
      host.say(
        message === null
          ? `Forked ${from}: the new session continues its whole conversation; /handoff moves it to another account.`
          : `Forked ${from} before ${messageWords(message.text)}: the new session continues the conversation up to there, with that prompt as its draft; /handoff moves it to another account.`,
      );
    });
  };

  // The rewind a stop was asked for goes once the run it stopped is no longer the session's live run, held while the
  // environment is out of reach (the run may still be live there), for at most STOP_WAIT_MS; another session opened drops it.
  const waitingOn = waiting !== null && opened !== null && waiting.target.environmentId === opened.environmentId && waiting.target.sessionId === opened.sessionId;
  const ended = waitingOn && host.liveRunId !== waiting.runId && !outOfReach(runtimeRewind);
  useEffect(() => {
    if (waiting === null) return;
    if (!waitingOn) return setWaiting(null);
    if (!ended) return;
    setWaiting(null);
    // No key asks this rewind: the wait may have outlasted the start of the next message.
    rewindOn(waiting.target, waiting.message, false);
  }, [waiting, waitingOn, ended]);
  useEffect(() => {
    if (waiting === null) return;
    // Cancelled when the wait ends another way (the rewind sent, another session opened), so firing means it is still waiting.
    const timer = host.clock.setTimeout(() => {
      setWaiting(null);
      host.say(`The run has not ended since the stop: not rewound. /rewind again once it has.`);
    }, STOP_WAIT_MS);
    return () => timer.cancel();
  }, [waiting]);

  return {
    verbs,
    offersStop,
    rewind(message) {
      const found = sessionFor("rewind");
      if (found) rewindTo(found.target, found.verbs, message, true);
    },
    rewindBack(back) {
      const found = sessionFor("rewind");
      if (!found) return;
      const all = messages();
      const message = messageBack(all, back);
      if (message) rewindTo(found.target, found.verbs, message, false);
      else host.say(tooFarBack(all.length, "rewind"));
    },
    fork(message) {
      const found = sessionFor("fork");
      if (found) forkAt(found.target, found.verbs, message);
    },
    forkBack(back) {
      const found = sessionFor("fork");
      if (!found) return;
      if (back === null) return forkAt(found.target, found.verbs, null);
      const all = messages();
      const message = messageBack(all, back);
      if (message) forkAt(found.target, found.verbs, message);
      else host.say(tooFarBack(all.length, "fork from"));
    },
    undo() {
      const found = sessionFor("undo a rewind on");
      if (!found) return;
      const verb = found.verbs.undoRewind;
      if (verb.status === "absent") return host.say(verb.reason === "no_rewind" ? verb.message : `Not undone: ${verb.message}`);
      const { environmentId, sessionId } = found.target;
      // The composer's text goes first: the environment puts back the draft from before the rewind only while the draft is the rewind's.
      runtime.drafts.flush();
      void runtime.commands.dispatch(environmentId, "sessions.undoRewind", { sessionId }).then((answer) => {
        if (!answer.ok) host.say(`Not undone: ${answer.error.message}`);
      });
    },
    carriedDraft() {
      const own = host.projection?.draft ?? null;
      if (own !== null && own !== "") return own;
      if (!opened || (host.projection?.runs.length ?? 0) > 0) return null;
      return anchored.current.get(keyOf(opened)) ?? null;
    },
  };
};
