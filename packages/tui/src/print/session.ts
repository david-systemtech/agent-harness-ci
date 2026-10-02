import { posix } from "node:path";
import type { SessionSummary } from "@agent-harness/contracts";
import type { TerminalSelection } from "../startup/selection.js";
import { nameOf } from "../view.js";
import { PrintFailure } from "./failure.js";

/**
 * Where a printed turn goes (docs/specs/switch-over.md L97-L99): a session
 * to continue, `--session`'s or the newest `-c` finds, once the
 * environment says it is idle; else a fresh session in the directory, or in
 * a scratch workspace of its own on another machine's environment, where
 * this machine's directory means nothing.
 */
export type Target =
  | { readonly sessionId: string; readonly summary: SessionSummary }
  | { readonly sessionId: null; readonly workspace: string | undefined };

/** A workspace path as compared: normalised, without a trailing slash. */
const comparable = (path: string): string => posix.normalize(path).replace(/(.)\/+$/, "$1");

/** The newest unarchived session working in `directory`, whatever its workspace's kind: updated time descending, then id ascending. */
const latestIn = (sessions: readonly SessionSummary[], directory: string): SessionSummary | undefined =>
  sessions
    .filter((summary) => summary.archivedAt === null && comparable(summary.workspace.path) === comparable(directory))
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];

export const targetOf = async (selection: TerminalSelection): Promise<Target> => {
  const { environment, session, runtime } = selection;
  const name = nameOf(environment);
  const elsewhere = environment.kind !== "local" && session.cwd === undefined;
  let sessionId = session.sessionId;
  if (sessionId === undefined && !session.continueLatest) return { sessionId: null, workspace: elsewhere ? undefined : session.workspace };
  if (sessionId === undefined) {
    if (elsewhere) throw new PrintFailure(`-c on ${name}, another machine's environment, needs --cwd naming the directory there.`, 2);
    const listed = await runtime.requests.call(environment.environmentId, "sessions.list", {});
    if (!listed.ok) throw new PrintFailure(`${name} did not list its sessions: ${listed.error.message}`);
    const latest = latestIn(listed.result.sessions, session.workspace);
    if (latest === undefined) throw new PrintFailure(`${name} has no session in ${session.workspace} to continue.`);
    sessionId = latest.id;
  }
  // The session as the environment has it now: a run under way there is refused rather than queued behind.
  const read = await runtime.requests.call(environment.environmentId, "sessions.get", { sessionId });
  if (!read.ok) throw new PrintFailure(read.error.code === "not_found" ? `${name} has no session ${sessionId}.` : `${name} did not read session ${sessionId}: ${read.error.message}`);
  const { summary } = read.result;
  if (summary.activity.state !== "idle") throw new PrintFailure(`Session ${summary.id} on ${name} has a run ${summary.activity.state}: a print starts only on an idle session.`);
  return { sessionId: summary.id, summary };
};
