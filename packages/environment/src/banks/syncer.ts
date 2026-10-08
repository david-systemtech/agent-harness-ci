import { ContractError, type BankEntry, type BankRecord } from "@agent-harness/contracts";
import type { ForgeGitAnswer, ForgeGitRequest } from "../forge/harness-git.js";
import { refusalCause } from "../forge/operations.js";
import type { Clock, Timer } from "../serve/clock.js";
import { runGit } from "../workspace/git.js";
import { REGISTERED_SYNC_BLOCKED, type BankService } from "./bank-service.js";

/** The banks spec's shared before-run budget, stale boundary and idle cadence. */
const STALE_MS = 60_000;
const RUN_WAIT_MS = 3_000;
const SYNC_MS = 30 * 60_000;
const MAIN = "refs/remotes/origin/main";

export interface BankSyncer {
  beforeRun(scope: { readonly accountId: string; readonly repositoryIdentity: string | null }): Promise<void>;
  sync(bankId?: string): Promise<BankRecord[]>;
  start(): void;
  close(): Promise<void>;
}

/** Fetches join per bank, including across runs, Pull now and the idle scheduler. The deadline never cancels a fetch. */
export const createBankSyncer = (options: { readonly banks: BankService; readonly clock: Clock; readonly git: (request: ForgeGitRequest, bankId: string) => Promise<ForgeGitAnswer> }): BankSyncer => {
  const { banks, clock } = options;
  const controller = new AbortController();
  const running = new Map<string, Promise<void>>();
  const waits = new Set<() => void>();
  let interval: Timer | undefined;
  let closed = false;

  const fetchRemote = async (bank: BankEntry): Promise<void> => {
    if (bank.location.kind !== "remote") return;
    const local = (args: readonly string[]) => runGit(bank.checkout, args, { maxBytes: 64 * 1024, signal: controller.signal });
    const previous = await local(["rev-parse", "HEAD"]);
    if (controller.signal.aborted) return;
    const answer = await options.git({
      operation: "fetch",
      repository: `${bank.location.origin}/${bank.location.repository}.git`,
      cwd: bank.checkout,
      purpose: "sync a memory bank",
      refspecs: [`+refs/heads/main:${MAIN}`],
      signal: controller.signal,
    }, bank.id);
    if (controller.signal.aborted) return;
    if (answer.outcome === "refused" || !answer.git.ok || answer.git.timedOut || answer.git.truncated) {
      await banks.recordSync(bank.id, { problem: answer.outcome === "refused" ? refusalCause(answer.error) : "Fetching the bank's main failed." });
      return;
    }
    // Adopted paths, including older records, retain the owner's work.
    if (bank.checkoutOwnership !== "managed") {
      const status = await local(["status", "--porcelain", "--untracked-files=no"]);
      const ancestor = await local(["merge-base", "--is-ancestor", "HEAD", MAIN]);
      let problem: string | null = null;
      if (!status.ok || status.timedOut || status.truncated) problem = "The tracked files could not be checked. Check the checkout with git status and retry Pull now.";
      else if (status.stdout.length !== 0) problem = "Tracked files have local changes. Commit or stash them, then retry Pull now.";
      else if (!ancestor.ok || ancestor.timedOut || ancestor.truncated) problem = "Local commits cannot fast-forward to origin/main. Reconcile them with origin/main, then retry Pull now.";
      else {
        // Git refuses an obstructing untracked file; no reset or clean may follow a refusal.
        const forward = await local(["-c", "merge.autostash=false", "merge", "--ff-only", "--no-overwrite-ignore", MAIN]);
        if (!forward.ok || forward.timedOut || forward.truncated) problem = "The fast-forward was refused. Check git status, move any obstructing untracked or ignored files, then retry Pull now.";
      }
      if (controller.signal.aborted) return;
      const head = problem === null ? await local(["rev-parse", "HEAD"]) : null;
      if (controller.signal.aborted) return;
      if (head === null || !head.ok || head.timedOut || head.truncated) {
        await banks.recordSync(bank.id, { problem: `${REGISTERED_SYNC_BLOCKED} ${bank.checkout}: ${problem ?? "The refreshed head could not be read. Check the checkout and retry Pull now."}` });
        return;
      }
      await banks.recordSync(bank.id, { head: head.stdout.toString("utf8").trim(), previousHead: previous.ok ? previous.stdout.toString("utf8").trim() : null });
      return;
    }
    // An owned checkout has no authored changes: divergence or a dirty worktree is reset, never merged.
    const ancestor = await local(["merge-base", "--is-ancestor", "HEAD", MAIN]);
    const status = await local(["status", "--porcelain"]);
    const forward = ancestor.ok && status.ok && status.stdout.length === 0 ? await local(["merge", "--ff-only", MAIN]) : null;
    const moved = forward?.ok === true ? forward : await local(["reset", "--hard", MAIN]);
    // Untracked and ignored writes also belong outside this owned checkout.
    const cleaned = moved.ok ? await local(["clean", "-fdx"]) : null;
    const head = cleaned?.ok === true ? await local(["rev-parse", "HEAD"]) : null;
    if (controller.signal.aborted) return;
    if (head === null || !head.ok) {
      await banks.recordSync(bank.id, { problem: "Refreshing the bank's owned checkout failed." });
      return;
    }
    await banks.recordSync(bank.id, { head: head.stdout.toString("utf8").trim(), previousHead: previous.ok ? previous.stdout.toString("utf8").trim() : null });
  };

  const fetchOne = (bank: BankEntry): Promise<void> => bank.location.kind === "local"
    ? banks.verify(bank.id).then(() => undefined)
    : banks.withCheckout(bank.id, () => fetchRemote(bank));

  const join = (bank: BankEntry): Promise<void> => {
    const held = running.get(bank.id);
    if (held !== undefined) return held;
    const work = fetchOne(bank).catch(async () => {
      if (!closed) await banks.recordSync(bank.id, { problem: "Syncing the bank failed." });
    }).finally(() => running.delete(bank.id));
    running.set(bank.id, work);
    return work;
  };

  const enabled = (): BankEntry[] => banks.entries().map(({ entry }) => entry).filter((entry) => entry.enabled);
  const all = async (entries: readonly BankEntry[]): Promise<void> => { await Promise.all(entries.map(join)); };
  const scheduled = (): void => { void all(enabled()).catch((error: unknown) => console.error("Syncing memory banks failed:", error)); };

  return {
    async beforeRun({ accountId, repositoryIdentity }) {
      if (closed) return;
      const stale = enabled().filter((bank) =>
        bank.location.kind === "remote" &&
        (bank.accounts === "all" || bank.accounts.includes(accountId)) &&
        (bank.repositories === "all" || (repositoryIdentity !== null && bank.repositories.includes(repositoryIdentity))) &&
        (bank.status.lastSync === null || clock.now().getTime() - Date.parse(bank.status.lastSync) > STALE_MS),
      );
      if (stale.length === 0) return;
      const complete = all(stale);
      let timer: Timer | undefined;
      let release!: () => void;
      const deadline = new Promise<void>((resolve) => { release = resolve; timer = clock.setTimeout(resolve, RUN_WAIT_MS); });
      waits.add(release);
      try { await Promise.race([complete, deadline]); }
      finally { timer?.cancel(); waits.delete(release); }
    },
    async sync(bankId) {
      if (closed) return banks.list();
      const bank = bankId === undefined ? null : banks.entries().find(({ entry }) => entry.id === bankId)?.entry;
      if (bankId !== undefined && bank === undefined) throw new ContractError({ code: "not_found", message: `No bank ${bankId} is registered on this environment.`, data: {} });
      await all(bank == null ? enabled() : [bank]);
      return banks.list();
    },
    start() {
      if (closed || interval !== undefined) return;
      scheduled();
      interval = clock.setInterval(scheduled, SYNC_MS);
    },
    async close() {
      closed = true;
      interval?.cancel();
      controller.abort();
      for (const release of waits) release();
      await Promise.allSettled(running.values());
    },
  };
};
