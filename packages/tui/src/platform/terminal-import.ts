import type { Runtime } from "@agent-harness/client-runtime";
import { currentEnvironment } from "../view.js";
import type { HistoryEntry } from "../composer/history.js";
import type { Snippet } from "../composer/snippets.js";
import { commitTerminalBatch, terminalCompletion, type TerminalPart } from "./terminal-batch.js";
import type { TerminalCommitFaults } from "./terminal-files.js";

interface SourceRecords<T> {
  readonly status: "absent" | "read" | "partial" | "failed";
  readonly records: readonly T[];
}
/** The source reader's normalised records, with no dependency on Environment implementation. */
export interface TerminalImportSource {
  readonly sourceKey: string;
  readonly history: SourceRecords<HistoryEntry>;
  readonly snippets: SourceRecords<Snippet>;
  readonly afterEdit: SourceRecords<{ readonly cwd: string; readonly command: string }>;
  readonly diagnostics: readonly { readonly part: TerminalPart; readonly reason: string; readonly count: number }[];
}

/** Import only terminal-local records; the sole Environment request verifies history associations. */
export const importTerminalState = async (options: {
  readonly source: TerminalImportSource;
  readonly stateDir: string;
  readonly runtime: Runtime;
  readonly environment?: string | undefined;
  readonly faults?: TerminalCommitFaults;
}): Promise<readonly string[]> => {
  const { source, stateDir, runtime } = options;
  const done = terminalCompletion(stateDir, source.sourceKey);
  const pending = (["history", "snippets", "afterEdit"] as const).filter((part) => !done.includes(part));
  if (pending.length === 0) return [];
  const messages = source.diagnostics.filter(({ part }) => pending.includes(part))
    .map(({ part, reason, count }) => `Terminal import: ${part}: ${reason} (${count}). Retry with --import-terminal-state after repair.`);
  let history = source.history.status === "failed" ? undefined : source.history.records;
  if (pending.includes("history") && history?.some((entry) => entry.sessionId !== undefined)) {
    const views = runtime.projections.environments.read();
    const selected = currentEnvironment(views, runtime.preferences.read(), options.environment);
    let held = new Set<string>();
    if (selected?.kind === "local") {
      const answer = await runtime.requests.call(selected.environmentId, "sessions.list", {});
      if (answer.ok) held = new Set(answer.result.sessions.map(({ id }) => id));
      else {
        history = undefined;
        messages.push("Terminal import: history: local Environment unavailable; retry with --import-terminal-state.");
      }
    }
    history = history?.map(({ sessionId, ...entry }) => sessionId !== undefined && held.has(sessionId) ? { ...entry, sessionId } : entry);
  }
  const completed = pending.filter((part) => source[part].status === "read" || source[part].status === "absent");
  commitTerminalBatch(stateDir, {
    sourceKey: source.sourceKey,
    completed,
    ...(pending.includes("history") && history !== undefined ? { history } : {}),
    ...(pending.includes("snippets") && source.snippets.status !== "failed" ? { snippets: source.snippets.records } : {}),
    ...(pending.includes("afterEdit") && source.afterEdit.status !== "failed" ? { afterEdit: source.afterEdit.records } : {}),
  }, options.faults);
  return messages;
};
