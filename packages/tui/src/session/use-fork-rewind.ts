import {
  liveRunIdOf,
  messageBack,
  oneLine,
  stopFirstOffer,
  tooFarBack,
  userMessagesOf,
  type RewindAnswer,
  type Runtime,
  type SessionProjection,
  type SessionRunsView,
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
 * rewind: `commands.rewind`'s stop-first form (#390), which interrupts the
 * run and rewinds once it has ended, the runtime's rule for every client
 * (`stopFirstOffer`: not while messages are queued, nor while the run is only
 * starting). A rewind to the session's first user message is
 * `commands.rewind`'s to turn into a new session (`use_new_session`), which
 * is opened. A fork is `commands.fork`, opened once the environment has it,
 * holding the anchored message as its draft; `/handoff` on it moves its next
 * run to another account, the runtime carrying the draft.
 */

/** A user message as a line names it: its first line, cut. */
export const messageWords = (text: string): string => oneLine(text, 80);

/** A user message a rewind or a fork is anchored at. */
export type Anchor = Pick<UserMessageEntry, "messageId" | "text">;

export interface ForkRewindHost {
  readonly runtime: Runtime;
  readonly opened: Opened | null;
  readonly projection: SessionProjection | undefined;
  /** The open session's queue, rewind and verbs (`projections.runs.session`). */
  readonly runs: SessionRunsView | undefined;
  /** The run live on the open session, which a stop-and-rewind interrupts; undefined while none is, or one is only starting. */
  readonly liveRunId: string | undefined;
  say(line: string): void;
  ask(question: Question): void;
  openSession(opened: Opened): void;
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
  /** `commands.fork` before `message`, or of the whole session, the fork opened. */
  fork(message: Anchor | null): void;
  /** `/fork [n]`: a fork before the user message `back` from the end, or (null) of the whole session. */
  forkBack(back: number | null): void;
  /** `sessions.undoRewind` of the latest rewind standing. */
  undo(): void;
}

export const useForkRewind = (host: ForkRewindHost): ForkRewind => {
  const { runtime, opened, runs } = host;
  // The rewind as the runtime offers it now: a stop first while the live run can be stopped for it, else why not.
  const offer = runs === undefined ? undefined : stopFirstOffer(runs, host.liveRunId);
  const offersStop = offer !== undefined && offer.stops !== null;
  const verbs: ForkRewindVerbs | undefined =
    runs === undefined || offer === undefined ? undefined : { rewind: offer.rewind, fork: runs.verbs.fork, undoRewind: runs.verbs.undoRewind };
  const messages = (): readonly UserMessageEntry[] => (host.projection ? userMessagesOf(host.projection.items) : []);
  const title = (): string => host.projection?.summary?.title ?? "this session";

  /** The open session and its verbs, or undefined, said in one line, when there is none to `verb`. */
  const sessionFor = (verb: string): { readonly target: Opened; readonly verbs: ForkRewindVerbs } | undefined => {
    if (!opened) return void host.say(`No session is open to ${verb}: /resume opens one.`);
    if (verbs === undefined) return void host.say(`The session is still loading: try to ${verb} once it shows.`);
    return { target: opened, verbs };
  };

  /**
   * What a rewind answered, in one line or by opening the session it started. `workspace`: the rewound session's, read
   * when the rewind was asked for, since a stop-first rewind answers after its wait, when another session may be open.
   * `askedByKey`: a key action (the picker's Enter, `w`) asked for the rewind, so an offer to stop that follows takes y
   * and n whatever the composer holds.
   */
  const answered = (target: Opened, message: Anchor, workspace: string | undefined, done: RewindAnswer, askedByKey: boolean): void => {
    switch (done.kind) {
      case "new-session": {
        if (!done.answer.ok) return host.say(`No session was started: ${done.answer.error.message}`);
        host.openSession({ environmentId: target.environmentId, sessionId: done.sessionId });
        return host.say(
          `${messageWords(message.text)} was the first prompt, with nothing before it: a new session${workspace !== undefined ? ` in ${workspace}` : ""} starts with it as its draft.`,
        );
      }
      case "rewind": {
        const { answer } = done;
        if (answer.ok) return;
        if (answer.error.code === "conflict" && answer.error.data?.["reason"] === "run_active") return offerStop(target, message, askedByKey);
        return host.say(`Not rewound: ${answer.error.message}`);
      }
      case "refused":
        return host.say(`Not rewound: ${done.message}`);
      case "interrupt":
        return host.say(`Not interrupted: ${done.answer.error.message} Nothing was rewound.`);
      case "gave-up":
        return host.say("The run has not ended since the stop: not rewound. /rewind again once it has.");
    }
  };

  /** Stops the live run, then rewinds to `message` once it has ended: the runtime's stop-first rewind. */
  const stopThenRewind = (target: Opened, message: Anchor) => {
    const workspace = host.projection?.summary?.workspace.path;
    const stopping = () => host.say(`Stopping the run; the rewind to ${messageWords(message.text)} follows once it has ended.`);
    // No key asks what follows the wait: it may have outlasted the start of the next message.
    void runtime.commands.rewind(target.environmentId, target.sessionId, message.messageId, { stopFirst: true, onStopping: stopping }).then((done) => answered(target, message, workspace, done, false));
  };

  /** The stop-first rewind's offer on `target` as the runtime has it now, not as the render that asked for the rewind saw it. */
  const offerNow = (target: Opened) => {
    const view = runtime.projections.runs.session(target.environmentId, target.sessionId).read();
    return stopFirstOffer(view, liveRunIdOf(runtime.projections.session(target.environmentId, target.sessionId).read(), view));
  };

  /**
   * The offer to stop the live run, then rewind, unless the runtime says no stop can be had now (messages queued, the run
   * only starting), which is said in one line with nothing sent. Read afresh: an environment's refusal comes back after
   * the render that sent the rewind. `askedByKey`: a key action (the picker's Enter, `w`) asked for the rewind, so y and n
   * answer the offer whatever the composer holds; a typed `/rewind` emptied the composer, and its offer, which may come
   * once the next message is begun, leaves what is typed to the composer.
   */
  const offerStop = (target: Opened, message: Anchor, askedByKey: boolean) => {
    const now = offerNow(target);
    if (now.stops === null && now.rewind.status === "absent") return host.say(`Not rewound: ${now.rewind.message}`);
    host.ask({
      text: `A run is live: stop it, then rewind to ${messageWords(message.text)}? y/n`,
      yes: () => stopThenRewind(target, message),
      no: () => host.say("Not rewound: the run goes on."),
      whileTyping: askedByKey,
    });
  };

  const rewindOn = (target: Opened, message: Anchor, askedByKey: boolean) => {
    const workspace = host.projection?.summary?.workspace.path;
    void runtime.commands.rewind(target.environmentId, target.sessionId, message.messageId).then((done) => answered(target, message, workspace, done, askedByKey));
  };

  const rewindTo = (target: Opened, available: ForkRewindVerbs, message: Anchor, askedByKey: boolean) => {
    if (offersStop) return offerStop(target, message, askedByKey);
    if (available.rewind.status === "absent") return host.say(`Not rewound: ${available.rewind.message}`);
    rewindOn(target, message, askedByKey);
  };

  const forkAt = (target: Opened, available: ForkRewindVerbs, message: Anchor | null) => {
    if (available.fork.status === "absent") return host.say(`Not forked: ${available.fork.message}`);
    const { environmentId, sessionId } = target;
    const from = title();
    void runtime.commands.fork(environmentId, sessionId, message === null ? {} : { anchor: message.messageId }).then(({ sessionId: id, answer }) => {
      if (!answer.ok) return host.say(`Not forked: ${answer.error.message}`);
      host.openSession({ environmentId, sessionId: id });
      host.say(
        message === null
          ? `Forked ${from}: the new session continues its whole conversation; /handoff moves it to another account.`
          : `Forked ${from} before ${messageWords(message.text)}: the new session continues the conversation up to there, with that prompt as its draft; /handoff moves it to another account.`,
      );
    });
  };

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
  };
};
