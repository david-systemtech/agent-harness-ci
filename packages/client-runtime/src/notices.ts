import type { DeliveredOutcome, StepId } from "@agent-harness/contracts";
import { uuidv7 } from "./ids.js";
import { writable, type Observable } from "./observable.js";
import type { Clock } from "./platform.js";
import type { ConnectionAction, ConnectionNoticeKind } from "./connections/state-machine.js";

/**
 * `projections.notices` (docs/specs/client-runtime.md, "Projections"): the
 * queue of what the runtime has to tell David, newest last, at most
 * `NOTICE_LIMIT` long; dismissal is client-local and never saved. Three
 * sources feed it: the connection (revoked, expired, a protocol mismatch
 * either way, a failed token refresh); the environment's own stream, for
 * what is news to this client (`projections/notices.ts`, #127 and #142); and
 * the outbox's receipts (#128). A notice raised is heard by `onRaised`,
 * which the attention events (`projections/attention.ts`) take up.
 */

/** How many notices are kept; the oldest goes first. A chosen default. */
export const NOTICE_LIMIT = 100;

/**
 * What a notice is about: the connection's own kinds; from
 * `environment.subscribe`, `updated` (the environment now runs another
 * harness version), `update-failed` (an update did not take, and the
 * version it went from runs), `update-refused` (the environment or the desktop's
 * disk check refused `update-environment`), `draining` (it takes no new runs until it
 * restarts), `account` (an account changed in a way worth saying: the
 * environment's warning, or its sign-in status), `prompt-parked` (a run
 * waits for a person's answer) and `prompt-resolved` (a prompt this client
 * was told of was settled with nobody answering it), `forge` (a forge
 * account needs attention: a capability failed, a new problem, git refused
 * its credential, or an origin had none, #320), `key-manager` (a
 * key-manager connection came to stand in a status that needs David, #384),
 * `routine` (a routine's result delivered to the clients, a success or a
 * failure, #525), `workspace-kept` (a worktree stayed when the last session
 * naming it was purged, #330); and the outbox's (#128):
 * `command-rejected` (the environment refused a command, by its receipt or
 * an error) and `command-dropped` (a command left the outbox unsent,
 * whatever dropped it: seven days without reaching its environment, a run
 * command under a changed client session or never sent before the runtime
 * ended, a request that failed for another reason than its socket).
 */
export type NoticeKind =
  | ConnectionNoticeKind
  | "updated"
  | "update-failed"
  | "update-refused"
  | "draining"
  | "account"
  | "prompt-parked"
  | "prompt-resolved"
  | "forge"
  | "key-manager"
  | "routine"
  | "routine-delivery-failed"
  | "workspace-kept"
  | "command-rejected"
  | "command-dropped";

/**
 * A Set up step on the notice's environment, for a notice that step answers:
 * `setup.forges` on a forge notice (#320), `setup.key-manager` on a
 * key-manager notice (#384). The renderer opens the step there.
 */
export type StepAction = `setup.${StepId}`;
export type NoticeAction = ConnectionAction | StepAction;

/** The session, run and prompt a notice is about, for a renderer to open: a prompt's notices carry one. */
export interface NoticeSubject {
  readonly sessionId: string;
  readonly runId: string | null;
  readonly promptId: string | null;
}

/** A notice before it is raised: what it says and what it offers. */
export interface NoticeInput {
  readonly kind: NoticeKind;
  readonly message: string;
  readonly action: NoticeAction | null;
  /** Preset null. */
  readonly about?: NoticeSubject | null;
  /** Preset null. */
  readonly outcome?: DeliveredOutcome | null;
}

export interface Notice {
  /** A UUIDv7, so ids sort by when they were raised. */
  readonly id: string;
  readonly environmentId: string;
  readonly kind: NoticeKind;
  /** One line for people, the same in every renderer. */
  readonly message: string;
  /** What David can do about it, a name the renderer maps to a call: `re-pair`, `update-client`, `update-environment`, `service.start`, or a Set up step to open on its environment (`setup.forges`). */
  readonly action: NoticeAction | null;
  /** What it is about, when it is about a session: a prompt's notices name the session, run and prompt; a routine's, its firing's session. */
  readonly about: NoticeSubject | null;
  /** Whether a `routine` notice's result is a success (`succeeded`) or a failure (`failed`); null on every other notice. */
  readonly outcome: DeliveredOutcome | null;
  /** When it was raised. */
  readonly at: string;
}

export interface Notices {
  readonly list: Observable<readonly Notice[]>;
  raise(environmentId: string, draft: NoticeInput): Notice;
  /** Takes a notice off the queue; an id not on it is ignored. */
  dismiss(id: string): void;
  /** Takes every notice `match` picks off the queue, the runtime's own doing (a parked prompt's notice once the prompt is resolved); answers those taken. */
  retire(match: (notice: Notice) => boolean): readonly Notice[];
}

export const createNotices = (clock: Clock, onRaised?: (notice: Notice) => void): Notices => {
  const list = writable<readonly Notice[]>([]);
  return {
    list,
    raise(environmentId, draft) {
      const now = clock.now();
      const notice: Notice = {
        id: uuidv7(now),
        environmentId,
        kind: draft.kind,
        message: draft.message,
        action: draft.action,
        about: draft.about ?? null,
        outcome: draft.outcome ?? null,
        at: now.toISOString(),
      };
      list.update((current) => [...current, notice].slice(-NOTICE_LIMIT));
      onRaised?.(notice);
      return notice;
    },
    dismiss(id) {
      list.update((current) => (current.some((n) => n.id === id) ? current.filter((n) => n.id !== id) : current));
    },
    retire(match) {
      const taken = list.read().filter(match);
      if (taken.length > 0) list.update((current) => current.filter((n) => !taken.includes(n)));
      return taken;
    },
  };
};
