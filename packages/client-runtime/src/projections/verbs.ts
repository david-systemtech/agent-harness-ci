import { MAX_DRAFT_LENGTH, type AdapterCapabilities, type QueueHolder } from "@agent-harness/contracts";
import type { AbsentReason, CapabilityAnswer } from "../capabilities.js";
import type { RewoundAt, UserMessageEntry } from "./session.js";

/**
 * The verbs of ADR 0022 on one session (#230): read now, withdraw, fork,
 * rewind and undo rewind, each present or absent with a reason and one line
 * for people, so a renderer draws an absent verb dim with the reason and
 * never hides it, and both renderers say the same thing (ADR 0004). Pure:
 * what the runtime knows of the connection, the session's adapter, its run,
 * its queue, its rewind and its draft go in; the answers come out. In order,
 * the first that applies is the reason:
 *
 * 1. **The connection**, as `capability` answers for the verb's command: the
 *    scope it needs, and for a `runs:drive` command (read now, withdraw,
 *    rewind, undo) the environment reachable now, since a run command never
 *    queues (`unreachable`, `not-ready`). `sessions.fork` is `sessions:write`
 *    and queues while the environment is unreachable, as the outbox keeps
 *    it: only its scope counts.
 * 2. **The adapter's capability flag**: `fork` and `rewind` (reason
 *    `adapter`, in the adapter's own name). Read now and withdraw have no
 *    flag: without `providerQueue` the environment holds the queue itself
 *    and does both; the flag only says who holds a message. Undo rewind has
 *    none either: with no rewind there is nothing to undo. An adapter not
 *    known yet (its descriptor not read) decides nothing; the environment
 *    refuses what it cannot do.
 * 3. **The session's state**, as the environment would refuse it:
 *    `run_active` for a rewind or an undo while a run is live;
 *    `queued_messages` for a rewind while the environment holds queued
 *    messages; `run_started` for an undo once a run has started since the
 *    rewind; `draft_full` for a withdraw whose text the draft has no room
 *    for. And what the client can see there is nothing to do: `no_queue`
 *    (nothing to read now or withdraw), `no_message` (no message a run has
 *    read to rewind to), `no_rewind` (no rewind standing to undo).
 */

/** The command each verb dispatches. */
export type VerbMethod = "runs.readNow" | "runs.withdraw" | "sessions.fork" | "sessions.rewind" | "sessions.undoRewind";

/** Why a verb is absent: the connection's reason (`capability`'s), the adapter's flag, or the session's state. */
export type VerbReason =
  | AbsentReason
  | "adapter"
  | "run_active"
  | "queued_messages"
  | "run_started"
  | "draft_full"
  | "no_queue"
  | "no_message"
  | "no_rewind";

/** A verb present, or absent with its reason and one line for people: the shape of a capability's answer. */
export type VerbAvailability = { readonly status: "present" } | { readonly status: "absent"; readonly reason: VerbReason; readonly message: string };

/** Each verb of ADR 0022 on a session. */
export interface SessionVerbs {
  /** `runs.readNow`: interrupt a live run and read the whole queue now, or start the run of the queue the environment holds. */
  readonly readNow: VerbAvailability;
  /** `runs.withdraw` of the newest queued message, as the terminal UI's `↑` takes it; each queued message says its own. */
  readonly withdraw: VerbAvailability;
  /** `sessions.fork`, from the end or from a user message. */
  readonly fork: VerbAvailability;
  /** `sessions.rewind` to a user message a run has read; to the first, `commands.rewind` starts a new session instead. */
  readonly rewind: VerbAvailability;
  /** `sessions.undoRewind` of the latest rewind standing. */
  readonly undoRewind: VerbAvailability;
}

/** A message on the queued line (ADR 0022): sent during a run and not yet read, in the order sent. */
export interface QueuedMessage {
  readonly messageId: string;
  readonly text: string;
  /** Its attachments' names, in order. */
  readonly attachments: readonly string[];
  /** Who holds it: the provider (which may steer it into the running turn) or the environment (the next run reads it). */
  readonly heldBy: QueueHolder;
  /** The run it was sent during. */
  readonly runId: string;
  /** The sequence of its `message.sent`. */
  readonly sequence: number;
  readonly sentAt: string;
  /** Whether `runs.withdraw` can take it back now. */
  readonly withdraw: VerbAvailability;
}

export interface VerbsInput {
  /** The connection's answer for a verb's command (`capability`'s, or for `sessions.fork`, which queues, its scope's alone). */
  readonly connection: (method: VerbMethod) => CapabilityAnswer;
  /** The session's adapter; null while it is not known. */
  readonly adapter: Pick<AdapterCapabilities, "displayName" | "fork" | "rewind"> | null;
  /** A run of the session is live, or starting. */
  readonly live: boolean;
  /** The session's queue, in the order sent (`projections.session`'s `queued`). */
  readonly queued: readonly UserMessageEntry[];
  /** The latest rewind standing. */
  readonly rewound: RewoundAt | null;
  /** The transcript shows a user message a run has read: something to rewind to. */
  readonly rewindable: boolean;
  /** The session's draft, which a withdraw appends to. */
  readonly draft: string | null;
}

const PRESENT: VerbAvailability = { status: "present" };
const absent = (reason: VerbReason, message: string): VerbAvailability => ({ status: "absent", reason, message });

/** The first absent answer, else present. */
const first = (...checks: readonly (() => VerbAvailability | null)[]): VerbAvailability => {
  for (const check of checks) {
    const answer = check();
    if (answer !== null && answer.status === "absent") return answer;
  }
  return PRESENT;
};

/** The draft a withdraw of `text` leaves, as the environment writes it (#228): in place of an empty draft, else after it on a paragraph of its own. */
const draftAfterWithdraw = (draft: string | null, text: string): string => (draft === null || draft.length === 0 ? text : `${draft}\n\n${text}`);

/** Each verb's availability on the session, and its queue with each message's own withdraw. */
export const sessionVerbs = (input: VerbsInput): { readonly queue: readonly QueuedMessage[]; readonly verbs: SessionVerbs } => {
  const { adapter, live, queued, rewound } = input;
  const connection = (method: VerbMethod) => () => input.connection(method);
  const adapterCan = (flag: "fork" | "rewind", verb: string) => () => (adapter === null || adapter[flag] ? null : absent("adapter", `${adapter.displayName} cannot ${verb} a session.`));
  const noRun = (what: string) => () => (live ? absent("run_active", `A run is live on this session: stop it before ${what}.`) : null);

  const withdrawOf = (message: UserMessageEntry): VerbAvailability =>
    first(connection("runs.withdraw"), () =>
      draftAfterWithdraw(input.draft, message.text).length > MAX_DRAFT_LENGTH ? absent("draft_full", "The draft has no room for this message's text: shorten or clear it first.") : null,
    );
  const queue = queued.flatMap((message): QueuedMessage[] =>
    message.heldBy === null
      ? []
      : [
          {
            messageId: message.messageId,
            text: message.text,
            attachments: message.attachments.map((attachment) => attachment.name),
            heldBy: message.heldBy,
            runId: message.runId,
            sequence: message.sequence,
            sentAt: message.sentAt,
            withdraw: withdrawOf(message),
          },
        ],
  );
  const newest = queue.at(-1);
  // With no run live, what the provider still holds is a turn it opened, which reads it: the environment's queue is what a read-now starts a run with.
  const readable = queue.some((message) => message.heldBy === "environment" || live);

  const verbs: SessionVerbs = {
    readNow: first(connection("runs.readNow"), () => (readable ? null : absent("no_queue", "Nothing is queued to read."))),
    withdraw: first(connection("runs.withdraw"), () => (newest === undefined ? absent("no_queue", "Nothing is queued to withdraw.") : newest.withdraw)),
    fork: first(connection("sessions.fork"), adapterCan("fork", "fork")),
    rewind: first(
      connection("sessions.rewind"),
      adapterCan("rewind", "rewind"),
      noRun("rewinding"),
      () => (queue.some((message) => message.heldBy === "environment") ? absent("queued_messages", "Messages are queued: withdraw them, or let a run read them, before rewinding.") : null),
      () => (input.rewindable ? null : absent("no_message", "No message a run has read to rewind to.")),
    ),
    undoRewind: first(
      connection("sessions.undoRewind"),
      noRun("undoing the rewind"),
      () => (rewound === null ? absent("no_rewind", "Nothing has been rewound.") : null),
      () => (rewound?.undoable === false ? absent("run_started", "A run has started since the rewind, so it can no longer be undone.") : null),
    ),
  };
  return { queue, verbs };
};
