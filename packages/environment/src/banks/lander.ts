import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { BankManifest, ENVIRONMENT_STREAM_KIND, normaliseRemote, type BankDraft, type BankEntry, type MemoryPromoteResult } from "@agent-harness/contracts";
import { bankTreeOf, readBankMarkdown, validateBank } from "@agent-harness/contracts/bank-validator";
import type { EventLog } from "../event-log/event-log.js";
import type { ForgeService } from "../forge/forge-service.js";
import type { ForgeAnswer } from "../forge/operations.js";
import type { Clock } from "../serve/clock.js";
import type { ScrubRegistry } from "../scrub/registry.js";
import { runGit } from "../workspace/git.js";
import { readBankFiles } from "./bank-files.js";
import { BANKS_ACTOR, type BankService } from "./bank-service.js";

const REMOTE_MAIN = "refs/remotes/origin/main";
const CHECK_BUDGET_MS = 10 * 60_000;
const CHECK_POLL_MS = 5_000;
const valueOf = <T>(answer: ForgeAnswer<T>): T => {
  if (answer.outcome === "done") return answer.value;
  throw new Error(answer.outcome === "refused" ? answer.error.message : answer.message);
};

/** Landing writes in a detached worktree; the attached checkout only refreshes after main is verified. */
export const createBankLander = (options: {
  log: EventLog; environmentId: string; banks: BankService; forge: Pick<ForgeService, "list" | "pullRequests">;
  clock: Clock; scrub: ScrubRegistry; temporaryDirectory: (sessionId: string) => string;
}) => {
  const busy = new Set<string>();
  const controller = new AbortController();
  const running = new Set<Promise<MemoryPromoteResult>>();
  const promote = async (bank: BankEntry, sessionId: string, drafts: readonly BankDraft[]): Promise<MemoryPromoteResult> => {
    if (busy.has(bank.id)) {
      const reason = "A landing is already in progress for this bank.";
      options.log.atomically((tx) => options.log.append({ kind: ENVIRONMENT_STREAM_KIND, id: options.environmentId }, [{ type: "bank.landing-failed", payload: { bankId: bank.id, sessionId, step: "prepare", reason } }], { tx, actor: BANKS_ACTOR }));
      return { state: "failed", bank: bank.name, step: "prepare", reason };
    }
    busy.add(bank.id);
    let step = "prepare";
    let worktree: string | undefined;
    let root: string | undefined;
    let pullRequest: string | null = null;
    const git = async (cwd: string, args: readonly string[]) => {
      const answer = await runGit(cwd, args, { maxBytes: 1024 * 1024, signal: controller.signal });
      if (!answer.ok || answer.truncated) throw new Error(`Git ${args[0]} failed.`);
      return answer.stdout.toString("utf8").trim();
    };
    const emit = (type: string, payload: Record<string, unknown>) => options.log.atomically((tx) => options.log.append({ kind: ENVIRONMENT_STREAM_KIND, id: options.environmentId }, [{ type, payload: { bankId: bank.id, sessionId, ...payload } }], { tx, actor: BANKS_ACTOR }));
    const remote = bank.location.kind === "remote" ? bank.location : null;
    const main = remote === null ? "refs/heads/main" : REMOTE_MAIN;
    const network = async (operation: "fetch" | "push", cwd: string, refspecs: string[]) => {
      if (remote === null) throw new Error("The bank has no remote.");
      const answer = await options.banks.git(bank.id, { operation, cwd, refspecs, purpose: "land session memories", signal: controller.signal });
      if (answer.outcome === "refused") throw new Error(answer.error.message);
      if (!answer.git.ok || answer.git.truncated) throw new Error(`The bank's ${operation} failed.`);
    };
    try {
      if (controller.signal.aborted) throw new Error("The environment is closing.");
      // Review-pending work belongs to the review reconciler, not another promotion.
      const events = options.log.readStream({ kind: ENVIRONMENT_STREAM_KIND, id: options.environmentId }).filter((event) => event.payload["bankId"] === bank.id && ["bank.awaiting-review", "bank.landed"].includes(event.type));
      const held = events.at(-1);
      if (held?.type === "bank.awaiting-review") return { state: "awaiting-review", bank: bank.name, pullRequest: String(held.payload["pullRequest"]), files: [] };
      step = "fetch";
      if (remote !== null) await network("fetch", bank.checkout, [`+refs/heads/main:${REMOTE_MAIN}`, `+refs/heads/memory/${sessionId.slice(0, 8)}-*:refs/remotes/origin/memory/${sessionId.slice(0, 8)}-*`]);
      const base = await git(bank.checkout, ["rev-parse", main]);
      const temporary = options.temporaryDirectory(sessionId);
      await mkdir(temporary, { recursive: true, mode: 0o700 });
      root = await mkdtemp(join(temporary, "bank-landing-"));
      worktree = join(root, "worktree");
      await git(bank.checkout, ["worktree", "add", "--detach", worktree, base]);
      step = "validate";
      const files = await readBankFiles(worktree);
      const writes: Record<string, string | null> = {};
      for (const change of drafts) {
        for (const path of change.removePaths ?? []) writes[path] = null;
        writes[change.path] = change.kind === "draft" ? change.content : null;
      }
      // The queue is persisted state, but no path from it may escape the detached worktree or traverse a symlink.
      const memories = new Set(bankTreeOf([...Object.keys(files), ...Object.keys(writes)]).memories.map(({ path }) => path));
      for (const path of Object.keys(writes)) {
        if (!memories.has(path) || path.split("/").some((part) => part === "." || part === ".." || part === "")) throw new Error("A queued path is outside the bank's memories.");
      }
      const secret = options.scrub.check(JSON.stringify(drafts));
      if (secret !== null) throw new Error(`The queued changes contain a secret-shaped value (${secret}).`);
      const tree = await git(worktree, ["ls-tree", "-r", "-z", "HEAD"]);
      const links = tree.split("\0").filter((entry) => entry.startsWith("120000 ")).map((entry) => entry.slice(entry.indexOf("\t") + 1));
      if (Object.keys(writes).some((path) => links.some((link) => path === link || path.startsWith(`${link}/`)))) throw new Error("A queued path traverses a symbolic link.");
      const verdict = validateBank({ files, writes });
      if (!verdict.valid) throw new Error(`The current main refuses the changes: ${[...new Set(verdict.findings.filter((finding) => finding.severity === "refusal").map((finding) => finding.rule))].join(", ")}.`);
      const manifestFile = readBankMarkdown(files["BANK.md"] ?? "");
      const manifest = BankManifest.parse(manifestFile.ok ? manifestFile.data : null);
      if ((remote === null) !== (manifest.write.land === "commit")) throw new Error("The bank's landing mode does not match its location.");
      for (const [path, content] of Object.entries(writes)) {
        if (content === null) await rm(join(worktree, path), { force: true });
        else { await mkdir(dirname(join(worktree, path)), { recursive: true }); await writeFile(join(worktree, path), content); }
      }
      step = "commit";
      const account = remote === null ? null : options.forge.list().find((account) => account.origin === normaliseRemote(remote.origin)?.origin || account.aliases.some((alias) => alias.origin === remote.origin && alias.verifiedAt !== null));
      if (remote !== null && account?.identity == null) throw new Error("The bank needs a verified forge identity to author a landing.");
      const login = account?.identity?.login ?? bank.name;
      await git(worktree, ["add", "--all"]);
      const changed = await git(worktree, ["diff", "--cached", "--name-only"]) !== "";
      if (changed) await git(worktree, ["-c", `user.name=${login}`, "-c", `user.email=${login.replace(/[^a-zA-Z0-9._-]/g, "-")}@users.noreply`, "commit", "--quiet", "-m", "Promote session memories."]);
      let head = await git(worktree, ["rev-parse", "HEAD"]);
      if (remote === null) {
        step = "land";
        await git(bank.checkout, ["update-ref", "refs/heads/main", head, base]);
      } else if (changed) {
        step = "push";
        const prefix = `memory/${sessionId.slice(0, 8)}-`;
        const refs = await git(bank.checkout, ["for-each-ref", "--format=%(refname:short)", "refs/heads/memory/", "refs/remotes/origin/memory/"]);
        let n = 1;
        while (refs.split("\n").some((ref) => ref === `${prefix}${n}` || ref === `origin/${prefix}${n}`)) n++;
        const branch = `${prefix}${n}`;
        await git(bank.checkout, ["branch", branch, head]);
        await network("push", worktree, [`HEAD:refs/heads/${branch}`]);
        step = "pull-request";
        const target = { origin: remote.origin, repository: remote.repository, purpose: "land session memories" };
        const pr = valueOf(await options.forge.pullRequests.create({ ...target, title: "Promote session memories", body: "Validated session drafts and retirements.", head: branch, base: "main" }));
        pullRequest = pr.url;
        const orientation = new Set(manifest.orientation);
        const reviewed = drafts.some((draft) => orientation.has(draft.name) || [...(draft.removePaths ?? []), draft.path].some((path) => /\/decisions\//.test(path)));
        if (manifest.write.merge.memories !== "auto" || bank.mergeOverride === "review-memories" || reviewed) {
          emit("bank.awaiting-review", { pullRequest });
          return { state: "awaiting-review", bank: bank.name, pullRequest, files: Object.keys(writes).map((path) => ({ path, state: "pending" })) };
        }
        step = "validate-check";
        const checkController = new AbortController();
        const signal = AbortSignal.any([controller.signal, checkController.signal]);
        let expired!: () => void;
        const expiry = new Promise<never>((_, reject) => { expired = () => reject(new Error("The validate check did not succeed within ten minutes.")); });
        const timer = options.clock.setTimeout(() => { expired(); checkController.abort(); }, CHECK_BUDGET_MS);
        const aborted = new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(new Error("The validate check wait ended.")), { once: true }));
        try {
          for (;;) {
            const check = valueOf(await Promise.race([options.forge.pullRequests.validateCheck({ ...target, sha: head, signal }), expiry, aborted]));
            if (check === "failure") throw new Error("The bank's validate check failed.");
            if (check === "success") break;
            let poll: ReturnType<Clock["setTimeout"]> | undefined;
            try { await Promise.race([new Promise<void>((resolve) => { poll = options.clock.setTimeout(resolve, CHECK_POLL_MS); }), expiry, aborted]); }
            finally { poll?.cancel(); }
          }
        } finally { timer.cancel(); checkController.abort(); }
        step = "merge";
        valueOf(await options.forge.pullRequests.merge({ ...target, number: pr.number, expectedHead: head }));
        step = "fetch-merged-main";
        await network("fetch", bank.checkout, [`+refs/heads/main:${REMOTE_MAIN}`]);
        head = await git(bank.checkout, ["rev-parse", main]);
      }
      step = "verify";
      const landed = await readBankFiles(bank.checkout, head);
      for (const [path, content] of Object.entries(writes)) {
        const present = content === null ? await git(bank.checkout, ["ls-tree", "-r", "--name-only", head, "--", path]) !== "" : landed[path] !== content;
        if (present) throw new Error("A promoted file does not match main.");
      }
      step = "refresh";
      await git(bank.checkout, ["reset", "--hard", head]);
      await git(bank.checkout, ["clean", "-fdx"]);
      await options.banks.recordSync(bank.id, { head, previousHead: base });
      options.log.atomically((tx) => options.log.append({ kind: ENVIRONMENT_STREAM_KIND, id: options.environmentId }, [
        { type: "bank.landed", payload: { bankId: bank.id, sessionId, pullRequest, files: Object.keys(writes) } },
        { type: "bank.drafts-consumed", payload: { bankId: bank.id, sessionId, changes: [...drafts] } },
      ], { tx, actor: BANKS_ACTOR }));
      return { state: "landed", bank: bank.name, pullRequest, files: Object.entries(writes).map(([path, content]) => ({ path, state: content === null ? "removed" : "present" })) };
    } catch (error) {
      const reason = options.scrub.scrubOutput(error instanceof Error ? error.message : "Landing failed.");
      emit("bank.landing-failed", { step, reason });
      return { state: "failed", bank: bank.name, step, reason };
    } finally {
      if (worktree !== undefined) await runGit(bank.checkout, ["worktree", "remove", "--force", worktree], { maxBytes: 1024 * 1024 });
      if (root !== undefined) await rm(root, { recursive: true, force: true });
      busy.delete(bank.id);
    }
  };
  return {
    promote(bank: BankEntry, sessionId: string, drafts: readonly BankDraft[]) {
      const work = promote(bank, sessionId, drafts);
      running.add(work);
      void work.then(() => running.delete(work), () => running.delete(work));
      return work;
    },
    async close() { controller.abort(); await Promise.allSettled(running); },
  };
};
