import type { EnvironmentView } from "@agent-harness/client-runtime";
import type { SessionSummary } from "@agent-harness/contracts";
import type { SelectionOutcome } from "../startup/selection.js";
import { nameOf } from "../view.js";
import { directoryKey, machineRules, rulesOf } from "./directory.js";

/**
 * `agent-harness ls` (docs/specs/switch-over.md, "Phase-D commands and
 * parity"; #1181): the stored sessions of the environment the terminal UI
 * would show (the screenless selection), as its `sessions.list` answers
 * them now, a row a line on standard output.
 */

/** What `ls` asks, as the CLI parsed it. */
export interface ListRequest {
  /** `--cwd` as typed: on this machine's environment, from the current directory; on another, absolute there. */
  readonly cwd?: string | undefined;
  /** `--all`: every directory, whatever `cwd` says. */
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

/** Which sessions the request takes in on `environment`, or why it names no directory there: a usage error. */
const directoryFilter = (environment: EnvironmentView, request: ListRequest, io: ListIo): ((summary: SessionSummary) => boolean) | { readonly usage: string } => {
  if (request.all) return () => true;
  const name = nameOf(environment);
  let rules = machineRules(io.platform);
  let directory: string;
  if (environment.kind === "local") directory = rules.path.resolve(io.currentDirectory, request.cwd ?? ".");
  else if (request.cwd === undefined) {
    return { usage: `${name} is a paired environment, where this directory names nothing for certain: name a directory there with --cwd <path>, or every directory with --all.` };
  } else {
    const given = rulesOf(request.cwd);
    if (given === undefined) return { usage: `--cwd names a directory on ${name} by its absolute path there; got ${request.cwd}.` };
    rules = given;
    directory = request.cwd;
  }
  const key = directoryKey(rules, directory);
  return (summary) => directoryKey(rules, summary.workspace.path) === key;
};

/** Newest update first; the lower id first on a tie. */
const byUpdated = (a: SessionSummary, b: SessionSummary): number => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** A title on one line: each run of line breaks, with the white space around it, a space. */
const oneLine = (title: string): string => title.replace(/\s*(?:\r\n|[\n\r\u2028\u2029])\s*/g, " ");

/** The text rows: id, update time in UTC, the worktree's branch or `-`, and the title on one line. */
const textRows = (summaries: readonly SessionSummary[]): string => {
  const branches = summaries.map((summary) => (summary.workspace.kind === "worktree" ? summary.workspace.branch : "-"));
  const width = Math.max(...branches.map((branch) => branch.length));
  return summaries.map((summary, at) => `${summary.id}  ${new Date(summary.updatedAt).toISOString()}  ${branches[at]?.padEnd(width)}  ${oneLine(summary.title)}\n`).join("");
};

/** The JSON rows: each summary as the environment built it, beside the environment's id. */
const jsonRows = (environmentId: string, summaries: readonly SessionSummary[]): string =>
  summaries.map((summary) => `${JSON.stringify({ environmentId, summary })}\n`).join("");

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
    const inDirectory = directoryFilter(environment, request, io);
    if ("usage" in inDirectory) {
      io.stderr(`${inDirectory.usage}\n`);
      return 2;
    }
    const answer = await runtime.requests.call(environment.environmentId, "sessions.list", {});
    if (!answer.ok) {
      io.stderr(`The sessions on ${nameOf(environment)} could not be read: ${answer.error.message}\n`);
      return 1;
    }
    const summaries = answer.result.sessions.filter(inDirectory).sort(byUpdated);
    if (summaries.length > 0) io.stdout(request.json ? jsonRows(environment.environmentId, summaries) : textRows(summaries));
    return 0;
  } finally {
    await selection.close();
  }
};
