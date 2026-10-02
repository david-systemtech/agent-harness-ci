import { resolve } from "node:path";
import type { SessionSummary } from "@agent-harness/contracts";
import type { SelectionOutcome } from "../startup/selection.js";
import { nameOf } from "../view.js";

/**
 * `agent-harness ls` (docs/specs/switch-over.md, "Phase-D commands and
 * parity"; #1181): the stored sessions of the environment the terminal UI
 * would show (the screenless selection), as its `sessions.list` answers
 * them now, a row a line on standard output.
 */

/** What `ls` asks, as the CLI parsed it. */
export interface ListRequest {
  /** `--cwd` as typed. */
  readonly cwd?: string | undefined;
  /** `--all`: every directory. */
  readonly all: boolean;
  /** `--json`: one JSON row a line. */
  readonly json: boolean;
}

/** The process as listing uses it: its two streams, its working directory and its platform. */
export interface ListIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  /** The directory listed on this machine's environment when `--cwd` names none. */
  readonly currentDirectory: string;
  /** How this machine's environment compares directories. */
  readonly platform: NodeJS.Platform;
}

/** Newest update first; the lower id first on a tie. */
const byUpdated = (a: SessionSummary, b: SessionSummary): number => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** The text rows: id, update time in UTC, the worktree's branch or `-`, and the title on one line. */
const textRows = (summaries: readonly SessionSummary[]): string => {
  const branches = summaries.map((summary) => (summary.workspace.kind === "worktree" ? summary.workspace.branch : "-"));
  const width = Math.max(...branches.map((branch) => branch.length));
  return summaries.map((summary, at) => `${summary.id}  ${new Date(summary.updatedAt).toISOString()}  ${branches[at]?.padEnd(width)}  ${summary.title}\n`).join("");
};

/** Lists the sessions `request` asks for on the environment `select` chooses, and answers the exit code. */
export const listSessions = async (select: () => Promise<SelectionOutcome>, request: ListRequest, io: ListIo): Promise<number> => {
  const outcome = await select();
  if (!outcome.ok) {
    io.stderr(`${outcome.message}\n`);
    return 1;
  }
  const { selection } = outcome;
  try {
    const { environment, runtime } = selection;
    const directory = resolve(io.currentDirectory, request.cwd ?? ".");
    const answer = await runtime.requests.call(environment.environmentId, "sessions.list", {});
    if (!answer.ok) {
      io.stderr(`The sessions on ${nameOf(environment)} could not be read: ${answer.error.message}\n`);
      return 1;
    }
    const summaries = answer.result.sessions.filter((summary) => request.all || summary.workspace.path === directory).sort(byUpdated);
    if (summaries.length > 0) io.stdout(textRows(summaries));
    return 0;
  } finally {
    await selection.close();
  }
};
