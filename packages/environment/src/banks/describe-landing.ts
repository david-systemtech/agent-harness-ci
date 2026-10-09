import { realpath } from "node:fs/promises";
import { ENVIRONMENT_STREAM_KIND, SESSION_STREAM_KIND, type BankEntry } from "@agent-harness/contracts";
import { validateBank } from "@agent-harness/contracts/bank-validator";
import type { BankCredentials } from "./credentials.js";
import type { ForgeService } from "../forge/forge-service.js";
import type { EventLog } from "../event-log/event-log.js";
import { readSummary } from "../sessions/session-reads.js";
import { runGit } from "../workspace/git.js";
import { readBankFiles } from "./bank-files.js";
import type { BankChanges } from "./lander.js";
import { describeRepositoryAt } from "./describe-repository.js";

/** A clean run end submits committed describe artefacts, never a live or stopped conversation's partial work. */
export const createDescribeLanding = (options: {
  readonly log: EventLog;
  readonly dataDir: string;
  readonly environmentId: string;
  readonly forge: Pick<ForgeService, "pullRequests">;
  readonly git: BankCredentials["git"];
  readonly landChanges: (bankId: string, changes: BankChanges) => Promise<unknown>;
}) => {
  const reader = { all: <T>(sql: string, ...params: (string | number)[]): T[] => options.log.read<T>(sql, ...params) };
  const running = new Map<string, Promise<void>>();
  const failed = (bank: BankEntry, reason: string): void => {
    if (bank.status.landing.state === "failed" && bank.status.landing.step === "describe" && bank.status.landing.reason === reason) return;
    options.log.atomically((tx) => options.log.append({ kind: ENVIRONMENT_STREAM_KIND, id: options.environmentId }, [
      { type: "bank.landing-failed", payload: { bankId: bank.id, sessionId: null, step: "describe", reason } },
    ], { tx, actor: "system:banks" }));
  };
  const reconcile = async (bank: BankEntry): Promise<void> => {
    if (!bank.enabled || bank.role !== "read-write" || bank.status.landing.state === "awaiting-review") return;
    const [mint] = reader.all<{ session_id: string }>(
      `SELECT m.stream_id AS session_id FROM events m JOIN sessions s ON s.id = m.stream_id
       WHERE m.stream_kind = ? AND m.type = 'setup.minted' AND s.deleted_at IS NULL
         AND json_extract(m.payload, '$.step') = 'memory-bank' AND json_extract(m.payload, '$.subject.id') = ?
       ORDER BY m.sequence DESC LIMIT 1`, SESSION_STREAM_KIND, bank.id,
    );
    if (mint === undefined) return;
    const [run] = reader.all<{ run_id: string; state: string; reason: string | null }>(
      "SELECT run_id, state, reason FROM runs WHERE session_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1", mint.session_id,
    );
    if (run?.state !== "ended" || run.reason !== "completed") return;
    const [consumed] = reader.all<{ sequence: number }>(
      `SELECT sequence FROM events WHERE type IN ('bank.landed', 'bank.review-held')
         AND json_extract(payload, '$.bankId') = ? AND json_extract(payload, '$.sessionId') = ?
         AND sequence > (SELECT sequence FROM events WHERE stream_kind = ? AND stream_id = ?
           AND type = 'run.ended' AND json_extract(payload, '$.runId') = ? ORDER BY sequence DESC LIMIT 1) LIMIT 1`,
      bank.id, mint.session_id, SESSION_STREAM_KIND, mint.session_id, run.run_id,
    );
    if (consumed !== undefined) return;
    const workspace = readSummary(reader, mint.session_id)?.workspace;
    if (workspace?.kind !== "worktree" || !workspace.branch.startsWith("setup/describe-") ||
      await realpath(workspace.repository) !== await realpath(describeRepositoryAt(options.dataDir, bank.checkout))) {
      failed(bank, "The completed describe conversation is not in this bank's dedicated describe repository. Start a fresh describe session.");
      return;
    }
    const base = await runGit(workspace.repository, ["merge-base", "refs/heads/main", `refs/heads/${workspace.branch}`], { maxBytes: 1024 });
    if (!base.ok || base.truncated) throw new Error("The describe branch base could not be read.");
    const before = await readBankFiles(workspace.repository, base.stdout.toString("utf8").trim());
    const after = await readBankFiles(workspace.repository, `refs/heads/${workspace.branch}`);
    if (after["BANK.md"] === undefined) {
      if (before["BANK.md"] !== undefined) failed(bank, "The committed describe result has no BANK.md. Start a fresh describe session.");
      return;
    }
    const current = await readBankFiles(bank.checkout, "refs/heads/main");
    const writes = Object.fromEntries([...new Set([...Object.keys(before), ...Object.keys(after)])]
      .filter((path) => before[path] !== after[path] && current[path] !== after[path])
      .map((path) => [path, after[path] ?? null]));
    if (Object.keys(writes).length === 0) return;
    if (bank.location.kind === "local") {
      if (Object.keys(writes).some((path) => current[path] !== before[path])) {
        failed(bank, "The bank's main changed after this describe conversation started. Start a fresh describe session.");
        return;
      }
      await options.landChanges(bank.id, { writes, sessionId: mint.session_id, title: `Describe ${bank.name}.`, body: "Committed describe conversation artefacts." });
      return;
    }
    // The run authored and pushed this branch with its forge variables. Adopt its existing PR, never open another.
    const verdict = validateBank({ files: after });
    if (!verdict.valid) {
      failed(bank, `The committed describe result fails validation: ${[...new Set(verdict.findings.filter((finding) => finding.severity === "refusal").map((finding) => finding.rule))].join(", ")}.`);
      return;
    }
    const head = await runGit(workspace.repository, ["rev-parse", `refs/heads/${workspace.branch}`], { maxBytes: 1024 });
    if (!head.ok || head.truncated) throw new Error("The describe branch head could not be read.");
    const answer = await options.forge.pullRequests.listByHead({ origin: bank.location.origin, repository: bank.location.repository, branch: workspace.branch, limit: 5, purpose: "land a bank describe conversation" });
    if (answer.outcome !== "done") throw new Error("The describe pull requests could not be read.");
    const sha = head.stdout.toString("utf8").trim();
    const pr = answer.value.find((pr) => pr.base.ref === "main" && pr.head.sha === sha && pr.state !== "closed");
    if (pr === undefined) {
      failed(bank, "The committed describe result has no matching pull request on the bank's main. Open its pull request or start a fresh describe session.");
      return;
    }
    if (pr.state !== "merged") {
      const fetched = await options.git(bank.id, { operation: "fetch", cwd: bank.checkout, refspecs: [`+refs/heads/${workspace.branch}:refs/remotes/origin/${workspace.branch}`], purpose: "land a bank describe conversation" });
      if (fetched.outcome === "refused" || !fetched.git.ok || fetched.git.truncated) throw new Error("The describe branch could not be fetched.");
    }
    options.log.atomically((tx) => options.log.append({ kind: ENVIRONMENT_STREAM_KIND, id: options.environmentId }, [
      { type: "bank.review-held", payload: { bankId: bank.id, sessionId: mint.session_id, pullRequest: pr.url, number: pr.number, head: sha, writes, drafts: [] } },
      { type: "bank.awaiting-review", payload: { bankId: bank.id, sessionId: mint.session_id, pullRequest: pr.url } },
    ], { tx, actor: "system:banks" }));
  };
  return (bank: BankEntry): Promise<void> => {
    const held = running.get(bank.id);
    if (held !== undefined) return held;
    const work = reconcile(bank).catch(() => {
      // Git's stderr may contain credentials; report a category without copying repository output.
      failed(bank, "The committed describe artefact could not be read or fetched.");
    });
    running.set(bank.id, work);
    void work.finally(() => { if (running.get(bank.id) === work) running.delete(bank.id); }).catch(() => undefined);
    return work;
  };
};
