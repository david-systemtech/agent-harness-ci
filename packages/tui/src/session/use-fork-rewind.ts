import { useEffect, useState } from "react";
import type { Runtime, SessionProjection, SessionRunsView, TranscriptEntry, UserMessageEntry, VerbAvailability } from "@agent-harness/client-runtime";
import { oneLine } from "../transcript/format.js";
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
 * rewind: `runs.interrupt`, then, once the run has ended, `sessions.rewind`,
 * two commands, as the wire has no stop-and-rewind of its own. A rewind to
 * the session's first prompt is `commands.rewind`'s to turn into a new
 * session (`use_new_session`), which is opened. A fork is opened once the
 * environment has it, holding the anchored prompt as its draft; `/handoff`
 * on it moves its next run to another account.
 */

/** The prompts the picker lists and `/rewind n` and `/fork n` count back through: the user messages a run has read, in the visible transcript, oldest first. */
export const promptsOf = (items: readonly TranscriptEntry[]): readonly UserMessageEntry[] =>
  items.filter((entry): entry is UserMessageEntry => entry.kind === "user-message" && entry.delivery !== "queued");

/** The prompt `back` prompts from the end (1: the latest); undefined when there are fewer. */
export const promptBack = (prompts: readonly UserMessageEntry[], back: number): UserMessageEntry | undefined => (back >= 1 ? prompts[prompts.length - back] : undefined);

/** What `/rewind n` or `/fork n` says when there are not `n` prompts to go back through. */
export const tooFarBack = (count: number, verb: "rewind" | "fork from"): string =>
  count === 0 ? `Nothing to ${verb}: no prompt has been sent in this session yet.` : `There ${count === 1 ? "is only 1 prompt" : `are only ${count} prompts`} to go back through.`;

/** A prompt as a line names it: its first line, cut. */
export const promptWords = (text: string): string => oneLine(text, 80);

/** A prompt a rewind or a fork is anchored at. */
export type Anchor = Pick<UserMessageEntry, "messageId" | "text">;

export interface ForkRewindHost {
  readonly runtime: Runtime;
  readonly opened: Opened | null;
  readonly projection: SessionProjection | undefined;
  /** The open session's queue, rewind and verbs (`projections.runs.session`). */
  readonly runs: SessionRunsView | undefined;
  /** The run live on the open session, which a stop-and-rewind interrupts. */
  readonly liveRunId: string | undefined;
  say(line: string): void;
  ask(question: { readonly text: string; readonly yes: () => void; readonly no?: () => void }): void;
  openSession(opened: Opened): void;
  newSessionId(): string;
}

export interface ForkRewind {
  /** The verbs on the open session as they stand; absent with a reason while none is open. */
  readonly verbs: { readonly rewind: VerbAvailability; readonly fork: VerbAvailability; readonly undoRewind: VerbAvailability };
  /** `sessions.rewind` to `prompt` (a new session for the first), or stop-and-rewind while a run is live. */
  rewind(prompt: Anchor): void;
  /** `sessions.fork` before `prompt`, or of the whole session, the fork opened. */
  fork(prompt: Anchor | null): void;
  /** `sessions.undoRewind` of the latest rewind standing. */
  undo(): void;
}

const NO_SESSION: VerbAvailability = { status: "absent", reason: "no_message", message: "No session is open: /resume opens one." };

/** Whether an availability is the runtime's refusal because a run is live. */
export const refusedLive = (availability: VerbAvailability): boolean => availability.status === "absent" && availability.reason === "run_active";

export const useForkRewind = (host: ForkRewindHost): ForkRewind => {
  const { runtime, opened, runs } = host;
  const verbs = {
    rewind: runs?.verbs.rewind ?? NO_SESSION,
    fork: runs?.verbs.fork ?? NO_SESSION,
    undoRewind: runs?.verbs.undoRewind ?? NO_SESSION,
  };
  // A stop-and-rewind whose stop was accepted: the rewind waits for the run's end, on the session it was asked on.
  const [waiting, setWaiting] = useState<{ readonly target: Opened; readonly prompt: Anchor } | null>(null);
  const title = (): string => host.projection?.summary?.title ?? "this session";

  const stopThenRewind = (target: Opened, prompt: Anchor, runId: string | undefined) => {
    if (runId === undefined) return rewindOn(target, prompt);
    void runtime.commands.dispatch(target.environmentId, "runs.interrupt", { runId }).then((answer) => {
      if (!answer.ok) return host.say(`Not stopped, so not rewound: ${answer.error.message}`);
      setWaiting({ target, prompt });
      host.say(`Stopping the run; the rewind to ${promptWords(prompt.text)} follows once it has ended.`);
    });
  };

  const offerStop = (target: Opened, prompt: Anchor, runId: string | undefined) =>
    host.ask({
      text: `A run is live: stop it, then rewind to ${promptWords(prompt.text)}? y/n`,
      yes: () => stopThenRewind(target, prompt, runId),
      no: () => host.say("Not rewound: the run goes on."),
    });

  const rewindOn = (target: Opened, prompt: Anchor) => {
    const workspace = host.projection?.summary?.workspace.path;
    // What this terminal typed goes first, so the draft the rewind writes lands after it, and an undo can put it back.
    runtime.drafts.flush();
    void runtime.commands.rewind(target.environmentId, target.sessionId, prompt.messageId).then((done) => {
      if (done.kind === "new-session") {
        if (!done.answer.ok) return host.say(`No session was started: ${done.answer.error.message}`);
        host.openSession({ environmentId: target.environmentId, sessionId: done.sessionId });
        return host.say(`${promptWords(prompt.text)} was the first prompt, with nothing before it: a new session${workspace !== undefined ? ` in ${workspace}` : ""} starts with it as its draft.`);
      }
      const { answer } = done;
      if (answer.ok) return;
      if (answer.error.code === "conflict" && answer.error.data?.["reason"] === "run_active") {
        const runId = answer.error.data["runId"];
        return offerStop(target, prompt, typeof runId === "string" ? runId : undefined);
      }
      host.say(`Not rewound: ${answer.error.message}`);
    });
  };

  // The rewind a stop was asked for goes once the runtime no longer holds a run live on the session; another session opened drops it.
  const waitingOn = waiting !== null && opened !== null && waiting.target.environmentId === opened.environmentId && waiting.target.sessionId === opened.sessionId;
  const ended = waitingOn && !refusedLive(verbs.rewind);
  useEffect(() => {
    if (waiting === null) return;
    if (!waitingOn) return setWaiting(null);
    if (!ended) return;
    setWaiting(null);
    rewindOn(waiting.target, waiting.prompt);
  }, [waiting, waitingOn, ended]);

  return {
    verbs,
    rewind(prompt) {
      if (!opened) return host.say("No session is open to rewind: /resume opens one.");
      const verb = verbs.rewind;
      if (refusedLive(verb)) return offerStop(opened, prompt, host.liveRunId);
      if (verb.status === "absent") return host.say(`Not rewound: ${verb.message}`);
      rewindOn(opened, prompt);
    },
    fork(prompt) {
      if (!opened) return host.say("No session is open to fork: /resume opens one.");
      const verb = verbs.fork;
      if (verb.status === "absent") return host.say(`Not forked: ${verb.message}`);
      const { environmentId, sessionId } = opened;
      const id = host.newSessionId();
      const from = title();
      void runtime.commands.dispatch(environmentId, "sessions.fork", { sessionId, id, ...(prompt !== null && { atMessageId: prompt.messageId }) }).then((answer) => {
        if (!answer.ok) return host.say(`Not forked: ${answer.error.message}`);
        host.openSession({ environmentId, sessionId: id });
        host.say(
          prompt === null
            ? `Forked ${from}: the new session continues its whole conversation; /handoff moves it to another account.`
            : `Forked ${from} before ${promptWords(prompt.text)}: the new session continues the conversation up to there, with that prompt as its draft; /handoff moves it to another account.`,
        );
      });
    },
    undo() {
      if (!opened) return host.say("No session is open: /resume opens one.");
      const verb = verbs.undoRewind;
      if (verb.status === "absent") return host.say(verb.reason === "no_rewind" ? verb.message : `Not undone: ${verb.message}`);
      const { environmentId, sessionId } = opened;
      // The composer's text goes first: the environment puts back the draft from before the rewind only while the draft is the rewind's.
      runtime.drafts.flush();
      void runtime.commands.dispatch(environmentId, "sessions.undoRewind", { sessionId }).then((answer) => {
        if (!answer.ok) host.say(`Not undone: ${answer.error.message}`);
      });
    },
  };
};
