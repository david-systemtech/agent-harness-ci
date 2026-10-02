import type { EnvironmentView } from "@agent-harness/client-runtime";
import type { SessionSummary } from "@agent-harness/contracts";
import type { SelectionOutcome } from "../startup/selection.js";
import { nameOf } from "../view.js";
import { isDirectory, machineRules, rulesOf, type DirectoryRules } from "./directory.js";

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

/** The directory listed on an environment and the rules it is compared by; or why none is named there, a usage error. */
type Place = { readonly ok: true; readonly rules: DirectoryRules; readonly directory: string } | { readonly ok: false; readonly usage: string };

/**
 * The directory `cwd` names on `environment`: on this machine's, taken from
 * the current directory, which stands when `cwd` is undefined; on another,
 * only `cwd`, absolute there, since nothing proves this machine's directory
 * is one there.
 */
const placeOn = (environment: EnvironmentView, cwd: string | undefined, io: ListIo): Place => {
  if (environment.kind === "local") {
    const rules = machineRules(io.platform);
    return { ok: true, rules, directory: rules.path.resolve(io.currentDirectory, cwd ?? ".") };
  }
  const name = nameOf(environment);
  if (cwd === undefined) {
    return { ok: false, usage: `${name} is a paired environment, where this directory names nothing for certain: name a directory there with --cwd <path>, or every directory with --all.` };
  }
  const rules = rulesOf(cwd);
  if (rules === undefined) return { ok: false, usage: `--cwd names a directory on ${name} by its absolute path there; got ${cwd}.` };
  return { ok: true, rules, directory: cwd };
};

/** Newest update first; the lower id first on a tie. */
const byUpdated = (a: SessionSummary, b: SessionSummary): number => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** A title on one line: each run of line breaks, with the white space around it, a space. */
const oneLine = (title: string): string => title.replace(/\s*(?:\r\n|[\n\r\u2028\u2029])\s*/g, " ");

/** The text rows: id, update time in UTC, the worktree's branch or `-`, and the title on one line. */
const textRows = (summaries: readonly SessionSummary[]): string => {
  const rows = summaries.map((summary) => ({ summary, branch: summary.workspace.kind === "worktree" ? summary.workspace.branch : "-" }));
  const width = Math.max(...rows.map(({ branch }) => branch.length));
  return rows.map(({ summary, branch }) => `${summary.id}  ${new Date(summary.updatedAt).toISOString()}  ${branch.padEnd(width)}  ${oneLine(summary.title)}\n`).join("");
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
    let listed: (path: string) => boolean = () => true;
    if (!request.all) {
      const place = placeOn(environment, request.cwd, io);
      if (!place.ok) {
        io.stderr(`${place.usage}\n`);
        return 2;
      }
      listed = isDirectory(place.rules, place.directory);
    }
    const answer = await runtime.requests.call(environment.environmentId, "sessions.list", {});
    if (!answer.ok) {
      io.stderr(`The sessions on ${nameOf(environment)} could not be read: ${answer.error.message}\n`);
      return 1;
    }
    const summaries = answer.result.sessions.filter((summary) => listed(summary.workspace.path)).sort(byUpdated);
    if (summaries.length > 0) io.stdout(request.json ? jsonRows(environment.environmentId, summaries) : textRows(summaries));
    return 0;
  } finally {
    await selection.close();
  }
};
