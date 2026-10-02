import { z } from "zod";
import { RunId } from "./adapter.js";
import type { EventTypeEntry } from "./event-types.js";
import { AbsolutePath } from "./sessions.js";
import { TerminalId } from "./terminals.js";

/**
 * Workspace checks (switch-over spec, "Phase-D commands and parity",
 * Checks; #1187): one shell command per Workspace directory, which the
 * Environment keeps keyed by the directory's canonical path (its real path,
 * symlinks resolved), so every Session and Client in that directory shares
 * it, and which survives a restart. The environment runs it in a session's
 * terminal as `terminals.run` runs a one-off (`/bin/sh -c` on POSIX, in the
 * Workspace), never a client's shell, one check at a time per directory.
 * Each check is two events on the session that ran it: `checks.started` as
 * its terminal opens and `checks.finished` with its output, cut to its last
 * `CHECK_OUTPUT_MAX_BYTES`, once its command exits, it times out after
 * `CHECK_TIMEOUT_MS`, or it fails without an exit. A check never starts a
 * run and never sends anything to a model.
 */

/** How long a check's command runs before its terminal is closed and the check recorded timed out. */
export const CHECK_TIMEOUT_MS = 120_000;

/** The most of a check's output, in UTF-8 bytes, that `checks.finished` keeps: its last 64 KiB, marked truncated when more came. */
export const CHECK_OUTPUT_MAX_BYTES = 64 * 1024;

/** The longest check command, in characters (a chosen bound: it is carried by each `checks.*` event). */
export const CHECK_COMMAND_MAX_CHARS = 16 * 1024;

/** A check's shell text: kept and run verbatim, white space and newlines included; text with nothing but white space is refused. */
export const CheckCommand = z
  .string()
  .min(1)
  .max(CHECK_COMMAND_MAX_CHARS)
  .regex(/\S/)
  .meta({
    description:
      "A Workspace check's shell text, kept and run verbatim through the environment's one-off shell (/bin/sh -c on POSIX) in the Workspace directory; at most 16,384 characters, and not white space alone.",
  });
export type CheckCommand = z.infer<typeof CheckCommand>;

/** A Workspace directory's check, as `checks.get` and `checks.set` answer it and `checks.changed` announces it. */
export const WorkspaceCheck = z
  .object({
    workspace: AbsolutePath.meta({ description: "The session's Workspace directory as checks are keyed: its real path, symlinks resolved." }),
    command: CheckCommand.nullable().meta({ description: "The directory's check command, verbatim; null when none is set." }),
  })
  .meta({ description: "A Workspace directory's check: the canonical directory and its command, null when none is set." });
export type WorkspaceCheck = z.infer<typeof WorkspaceCheck>;

/** `checks.changed`: a directory's check command was set, changed or cleared, by the client session the event's actor names. */
export const ChecksChangedPayload = WorkspaceCheck.meta({
  description: "checks.changed: a Workspace directory's check command was set, changed or cleared (null); a client reads checks.get again for sessions in that directory.",
});
export type ChecksChangedPayload = z.infer<typeof ChecksChangedPayload>;

/**
 * Why a check ended without its command's exit: its terminal could not
 * start the command, was closed by a client (or with its session's
 * deletion) first, or the environment stopped while it ran, recorded as it
 * stopped or at its next start, the command never run again.
 */
export const CHECK_FAILURES = ["launch_failed", "closed", "interrupted"] as const;
export const CheckFailure = z.enum(CHECK_FAILURES).meta({
  description:
    "Why a check ended without its command's exit: launch_failed (the command could not start in its terminal), closed (its terminal was closed, or its session deleted, before the command exited) or interrupted (the environment stopped while it ran; the command is not run again).",
});
export type CheckFailure = z.infer<typeof CheckFailure>;

const checkPart = {
  terminalId: TerminalId.meta({ description: "The terminal the check runs in, which the environment opened and terminals.subscribe streams while it is open." }),
  command: CheckCommand,
  sourceRunId: RunId.nullable().meta({ description: "The run whose edits set the check off; null for a manual check." }),
};

/** `checks.started`: a check's terminal opened, running the directory's command. */
export const ChecksStartedPayload = z
  .object(checkPart)
  .meta({ description: "checks.started: a Workspace check began in the terminal named, running the command named; the source run is null for a manual check." });
export type ChecksStartedPayload = z.infer<typeof ChecksStartedPayload>;

/** `checks.finished`: how a check ended, once, after its `checks.started`. */
export const ChecksFinishedPayload = z
  .object({
    ...checkPart,
    output: z
      .string()
      .max(CHECK_OUTPUT_MAX_BYTES)
      .meta({ description: "The check's terminal output, scrubbed of registered values: its last 64 KiB (UTF-8) when more came." }),
    truncated: z.boolean().meta({ description: "Whether earlier output was dropped to keep the last 64 KiB." }),
    exitCode: z.int().nullable().meta({ description: "The command's exit code; null when it timed out or failed without exiting." }),
    signal: z.int().nullable().meta({ description: "The signal that ended the command, when one did; null otherwise." }),
    timedOut: z.boolean().meta({ description: "Whether the check ran past its 120 seconds and its terminal was closed." }),
    failure: CheckFailure.nullable().meta({ description: "Why the check ended without its command's exit; null when the command exited or timed out." }),
  })
  .meta({
    description:
      "checks.finished: how a Workspace check ended: its retained output and whether it was cut, the exit code and signal, whether it timed out, and why it failed without an exit. It passed only on exit code 0 with no signal, no timeout and no failure.",
  });
export type ChecksFinishedPayload = z.infer<typeof ChecksFinishedPayload>;

/** Whether a finished check passed: its command exited 0, by no signal, within its time, with no failure. */
export const checkPassed = (finished: Pick<ChecksFinishedPayload, "exitCode" | "signal" | "timedOut" | "failure">): boolean =>
  finished.exitCode === 0 && finished.signal === null && !finished.timedOut && finished.failure === null;

/** The check events of the `session` stream: unlisted, so the session list never changes with them. */
export const CHECK_SESSION_EVENT_TYPES = {
  "checks.started": { list: false, payload: ChecksStartedPayload },
  "checks.finished": { list: false, payload: ChecksFinishedPayload },
} as const satisfies Record<string, EventTypeEntry>;
