import { z } from "zod";
import { RunId } from "./adapter.js";
import { Sequence, Timestamp } from "./primitives.js";
import { SessionId } from "./sessions.js";
import { ToolStatus } from "./transcript.js";

/**
 * Terminals, files and diffs (tui spec, "Terminals, files and diffs: the
 * vocabulary this workstream fixes"; #124). Every method takes the `terminal`
 * scope. A terminal is an environment-owned pseudo-terminal attached to a
 * session's workspace, outliving any connection; its output never enters the
 * event log (ADR 0002 keeps the log for transcripts): each terminal keeps a
 * bounded scrollback of its own, and `terminals.subscribe` reads that and
 * nothing else. Files and diffs are read-only in phase A. The GUI (#84)
 * reuses this vocabulary and may add optional fields, never rename.
 */

/**
 * The stream kind a terminal's output rides on the wire as: `terminals.subscribe`
 * sends each output chunk, and the `exited` that ends it, as an `event` frame
 * whose envelope names this kind and the terminal's id. Such an envelope is
 * never in the log: its `sequence` and `streamVersion` are the terminal's own
 * output sequence, from 1, not the log's global one.
 */
export const TERMINAL_STREAM_KIND = "terminal";

/** A terminal's output chunk, as its subscription carries it. */
export const TERMINAL_OUTPUT_TYPE = "terminal.output";
/** A terminal's end, once, the last event of its subscription. */
export const TERMINAL_EXITED_TYPE = "terminal.exited";

/** What a terminal keeps of its output: 5,000 lines or 8 MiB, whichever comes first; the oldest goes. */
export const TERMINAL_SCROLLBACK = { lines: 5000, bytes: 8 * 1024 * 1024 } as const;

/** The most entries `files.list` answers. */
export const FILES_LIST_CAP = 20_000;

/** The most bytes `files.read` reads of a file. */
export const FILES_READ_CAP = 2 * 1024 * 1024;

/** The head `files.read` scans for a NUL byte to call a file binary, as git does. */
export const BINARY_SNIFF_BYTES = 8 * 1024;

/** The most bytes of diff text either `diffs.*` method answers. */
export const DIFF_CAP = 8 * 1024 * 1024;

/**
 * A terminal's id: a version 4 UUID the opening client mints, so it can
 * subscribe while its `terminals.open` is in flight; unique on the
 * environment, never reused, kept in lowercase.
 */
export const TerminalId = z.uuidv4().meta({
  description: "A terminal's id: a version 4 UUID the opening client mints, unique on the environment and never reused, kept in lowercase.",
});
export type TerminalId = z.infer<typeof TerminalId>;

/** A terminal's width in columns. */
export const TerminalColumns = z.int().min(1).max(1000).meta({ description: "A terminal's width in columns, 1 to 1,000." });
/** A terminal's height in rows. */
export const TerminalRows = z.int().min(1).max(1000).meta({ description: "A terminal's height in rows, 1 to 1,000." });

/** The size a terminal opens at when `terminals.open` names none. */
export const DEFAULT_TERMINAL_SIZE = { cols: 80, rows: 24 } as const;

/**
 * Environment variables a client adds to a terminal's shell, on top of the
 * environment's clean base (`TERM`, `PATH`, `HOME`, `LANG` and the user's
 * names), never the environment's own: at most 100, names as a POSIX shell
 * takes them, values without NUL.
 */
export const TerminalEnvironment = z
  .record(
    z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(256),
    z
      .string()
      .max(32 * 1024)
      .refine((value) => !value.includes("\0"), { message: "A value cannot hold NUL." }),
  )
  .refine((env) => Object.keys(env).length <= 100, { message: "At most 100 variables." })
  .meta({
    description:
      "Variables added to the shell's environment on top of the environment's clean base (TERM, PATH, HOME, LANG, the user's names); at most 100, names [A-Za-z_][A-Za-z0-9_]*, values without NUL.",
  });
export type TerminalEnvironment = z.infer<typeof TerminalEnvironment>;

/** Why a terminal ended: its process exited on its own, `terminals.close` closed it, or its session was deleted. */
export const TERMINAL_EXIT_CAUSES = ["exited", "closed", "deleted"] as const;
export const TerminalExitCause = z.enum(TERMINAL_EXIT_CAUSES).meta({
  description: "Why a terminal ended: its process exited on its own, terminals.close closed it, or its session was deleted.",
});
export type TerminalExitCause = z.infer<typeof TerminalExitCause>;

/** A terminal as `terminals.list` and a subscription's snapshot describe it. */
export const TerminalInfo = z
  .object({
    id: TerminalId,
    sessionId: SessionId,
    openedAt: Timestamp,
    cols: TerminalColumns,
    rows: TerminalRows,
    exitCode: z.int().nullable().meta({ description: "The shell's exit code once it has exited; null while it runs." }),
    signal: z.int().nullable().meta({ description: "The signal that ended the shell, when one did; null otherwise or while it runs." }),
  })
  .meta({ description: "A terminal: its id, session, when it opened, its size, and its exit code once it has exited." });
export type TerminalInfo = z.infer<typeof TerminalInfo>;

/** One chunk of a terminal's output, the payload of a `terminal.output` event. */
export const TerminalOutputPayload = z
  .object({ data: z.string().meta({ description: "The output, as the terminal wrote it, escape sequences and all." }) })
  .meta({ description: "terminal.output: one chunk of a terminal's output, never in the log." });
export type TerminalOutputPayload = z.infer<typeof TerminalOutputPayload>;

/** A terminal's end, the payload of the `terminal.exited` event its subscription ends on. */
export const TerminalExitedPayload = z
  .object({
    exitCode: z.int().meta({ description: "The shell's exit code." }),
    signal: z.int().nullable().meta({ description: "The signal that ended it, when one did." }),
    cause: TerminalExitCause,
  })
  .meta({
    description:
      "terminal.exited: the terminal ended, and why. The subscription ends after it: deleted when its session was deleted, closed otherwise.",
  });
export type TerminalExitedPayload = z.infer<typeof TerminalExitedPayload>;

/**
 * What `terminals.subscribe` sends as its snapshot: the terminal and the
 * scrollback it retains, the chunks `firstSequence` to `lastSequence` joined.
 * Sent to a subscription from cursor 0, and to one whose cursor the
 * scrollback no longer reaches (the note is `truncated`).
 */
export const TerminalSnapshot = z
  .object({
    terminal: TerminalInfo,
    scrollback: z.string().meta({ description: "The retained output, oldest first: at most 5,000 lines or 8 MiB." }),
    firstSequence: Sequence.meta({ description: "The sequence of the oldest chunk retained; 0 while there is none." }),
    lastSequence: Sequence.meta({ description: "The sequence of the newest chunk; 0 before any output. The snapshot frame's sequence." }),
    truncated: z.boolean().meta({
      description:
        "True when older output was dropped at the cap: the scrollback is the retained tail, and a cursor older than firstSequence missed what was dropped.",
    }),
  })
  .meta({ description: "A terminal's snapshot: the terminal and its retained scrollback with the sequences it spans." });
export type TerminalSnapshot = z.infer<typeof TerminalSnapshot>;

/** A path relative to a session's workspace, with forward slashes. */
export const WorkspacePath = z
  .string()
  .min(1)
  .max(4096)
  .meta({
    description:
      "A path relative to the session's workspace, with forward slashes. An absolute path, a .. segment, or a symlink that leads outside the workspace is refused invalid_params.",
  });
export type WorkspacePath = z.infer<typeof WorkspacePath>;

/** Where `files.list` read the workspace from: git's index and untracked files, or the bounded walk. */
export const FILES_LIST_SOURCES = ["git", "walk"] as const;
export const FilesListSource = z.enum(FILES_LIST_SOURCES).meta({
  description: "Where the listing came from: git (tracked and untracked, non-ignored files) or walk (the bounded walk with its skip list).",
});

/** One tool call's part in `diffs.session`: which run and call changed the file, with which tool, and how it ended. */
export const SessionDiffChange = z
  .object({
    runId: RunId,
    toolCallId: z.string().min(1),
    tool: z.string().min(1).meta({ description: "The tool's name as the provider gave it: Edit, MultiEdit, Write, NotebookEdit." }),
    status: ToolStatus,
  })
  .meta({ description: "One tool call that changed a file: its run, call, tool and how it ended." });
export type SessionDiffChange = z.infer<typeof SessionDiffChange>;

/** One file in `diffs.session`: its path, the unified diff of the session's changes to it, and the calls that made them. */
export const SessionDiffFile = z
  .object({
    path: z.string().min(1).meta({ description: "Relative to the workspace when the file is inside it, else as the tool named it." }),
    diff: z.string().meta({
      description:
        "A unified diff of the changes, one hunk per change in order. A hunk's line numbers are the file's when the tool's output carried its patch, else counted from the edited text.",
    }),
    changes: z.array(SessionDiffChange),
  })
  .meta({ description: "A file the session's runs changed: its path, the diff and the tool calls behind it." });
export type SessionDiffFile = z.infer<typeof SessionDiffFile>;
