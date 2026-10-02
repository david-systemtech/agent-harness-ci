import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { BankManifest, ENVIRONMENT_STREAM_KIND, normaliseRemote, type BankReviewHeldPayload, type BankDraft, type BankEntry, type MemoryPromoteResult } from "@agent-harness/contracts";
import { bankTreeOf, readBankMarkdown, validateBank } from "@agent-harness/contracts/bank-validator";
import type { EventEnvelope, EventLog } from "../event-log/event-log.js";
import type { ForgeService } from "../forge/forge-service.js";
import type { ForgeAnswer } from "../forge/operations.js";
import type { Clock } from "../serve/clock.js";
import type { ScrubRegistry } from "../scrub/registry.js";
import { runGit } from "../workspace/git.js";
import { readBankFiles } from "./bank-files.js";
import type { BankService } from "./bank-service.js";
import { formatActor } from "../event-log/envelope.js";
const BANKS_ACTOR = formatActor({ kind: "system", id: "banks" });

export interface BankChanges {
  readonly writes: Readonly<Record<string, string | null>>;
  /** Refuse a structural edit prepared from another main, so it cannot overwrite intervening authoring. */
  readonly expectedHead?: string;
  readonly sessionId?: string;
  readonly title: string;
  readonly body: string;
}


const REMOTE_MAIN = "refs/remotes/origin/main";
const CHECK_BUDGET_MS = 10 * 60_000;
const CHECK_POLL_MS = 5_000;
const REVIEW_POLL_MS = 30_000;
const REVIEW_REPLAY_BATCH = 1000;
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
  const active = new Map<string, Promise<MemoryPromoteResult>>();
  const reviews = new Map<string, BankReviewHeldPayload>();
  const rememberReview = (event: EventEnvelope) => {
    if (event.streamKind !== ENVIRONMENT_STREAM_KIND || event.streamId !== options.environmentId) return;
    const bankId = event.payload["bankId"];
    if (typeof bankId !== "string") return;
    if (event.type === "bank.review-held") reviews.set(bankId, event.payload as unknown as BankReviewHeldPayload);
    else if (event.type === "bank.landed" || event.type === "bank.forgotten") reviews.delete(bankId);
    else if (event.type === "bank.landing-failed" && event.payload["reviewReleased"] === true) reviews.delete(bankId);
  };
  // Rebuild once, in bounded batches; committed events maintain the index during this lifetime.
  let cursor = 0;
  for (;;) {
    const events = options.log.readStream({ kind: ENVIRONMENT_STREAM_KIND, id: options.environmentId }, cursor, REVIEW_REPLAY_BATCH);
    for (const event of events) rememberReview(event);
    const last = events.at(-1);
    if (last === undefined || events.length < REVIEW_REPLAY_BATCH) break;
    cursor = last.sequence;
  }
  const stopFollowing = options.log.subscribe(rememberReview);
  const heldReview = (bankId: string): BankReviewHeldPayload | null => reviews.get(bankId) ?? null;
  const promote = async (bank: BankEntry, sessionId: string | null, drafts: readonly BankDraft[], changes?: BankChanges): Promise<MemoryPromoteResult> => {
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
    let reviewReleased = false;
    const git = async (cwd: string, args: readonly string[]) => {
      const answer = await runGit(cwd, args, { maxBytes: 1024 * 1024, signal: controller.signal });
      if (!answer.ok || answer.truncated) throw new Error(`Git ${args[0]} failed.`);
      return answer.stdout.toString("utf8").trim();
    };
    const detachedAt = async (base: string) => {
      const temporary = options.temporaryDirectory(sessionId ?? bank.id);
      await mkdir(temporary, { recursive: true, mode: 0o700 });
      root = await mkdtemp(join(temporary, "bank-landing-"));
      worktree = join(root, "worktree");
      await git(bank.checkout, ["worktree", "add", "--detach", worktree, base]);
      return worktree;
    };
    const blob = async (cwd: string, ref: string, path: string) => {
      const entries = (await git(cwd, ["--literal-pathspecs", "ls-tree", "-z", ref, "--", path])).split("\0").filter(Boolean);
      const entry = entries[0];
      if (entries.length !== 1 || entry === undefined || !/^100(?:644|755) blob /.test(entry) || entry.slice(entry.indexOf("\t") + 1) !== path) {
        reviewReleased = heldReview(bank.id) !== null;
        throw new Error("A landed file is not a regular bank file.");
      }
      const answer = await runGit(cwd, ["show", `${ref}:${path}`], { maxBytes: 64 * 1024 * 1024, signal: controller.signal });
      if (!answer.ok || answer.truncated) throw new Error("A landed file could not be read.");
      return answer.stdout.toString("utf8");
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
    const finish = async (writes: Readonly<Record<string, string | null>>, consumed: readonly BankDraft[], head: string, previousHead: string): Promise<MemoryPromoteResult> => {
      step = "verify";
      for (const [path, content] of Object.entries(writes)) {
        const mismatch = content === null ? await git(bank.checkout, ["--literal-pathspecs", "ls-tree", "-r", "--name-only", head, "--", path]) !== "" : await blob(bank.checkout, head, path) !== content;
        if (mismatch) {
          reviewReleased = heldReview(bank.id) !== null;
          throw new Error("A landed file does not match main.");
        }
      }
      step = "refresh";
      await git(bank.checkout, ["reset", "--hard", head]);
      await git(bank.checkout, ["clean", "-fdx"]);
      await options.banks.recordSync(bank.id, { head, previousHead });
      options.log.atomically((tx) => options.log.append({ kind: ENVIRONMENT_STREAM_KIND, id: options.environmentId }, [
        { type: "bank.landed", payload: { bankId: bank.id, sessionId, pullRequest, files: Object.keys(writes) } },
        ...(consumed.length === 0 ? [] : [{ type: "bank.drafts-consumed", payload: { bankId: bank.id, sessionId, changes: [...consumed] } }]),
      ], { tx, actor: BANKS_ACTOR }));
      return { state: "landed", bank: bank.name, pullRequest, files: Object.entries(writes).map(([path, content]) => ({ path, state: content === null ? "removed" : "present" })) };
    };
    try {
      if (controller.signal.aborted) throw new Error("The environment is closing.");
      // The durable review record survives a restart and keeps the submitted bytes separate from later drafts.
      const review = heldReview(bank.id);
      if (review !== null) {
        if (changes !== undefined) throw new Error("A reviewed change is already awaiting reconciliation for this bank.");
        sessionId = review.sessionId;
        pullRequest = review.pullRequest;
        const pending = (): MemoryPromoteResult => {
          if (bank.status.landing.state !== "awaiting-review") emit("bank.awaiting-review", { pullRequest });
          return { state: "awaiting-review", bank: bank.name, pullRequest: review.pullRequest, files: Object.keys(review.writes).map((path) => ({ path, state: "pending" })) };
        };
        if (remote === null) throw new Error("A reviewed pull request needs a remote bank.");
        const target = { origin: remote.origin, repository: remote.repository, number: review.number, purpose: "review bank changes" };
        step = "review";
        const pr = valueOf(await options.forge.pullRequests.get(target));
        if (pr.base.ref !== "main" || (pr.state !== "merged" && pr.head.sha !== review.head)) {
          reviewReleased = true;
          throw new Error("The reviewed pull request's head or base changed.");
        }
        if (pr.state === "closed") {
          reviewReleased = true;
          throw new Error("The reviewed pull request was closed without merging.");
        }
        if (pr.state !== "merged") {
          if (!bank.enabled || bank.role !== "read-write") return pending();
          step = "fetch-review-main";
          await network("fetch", bank.checkout, [`+refs/heads/main:${REMOTE_MAIN}`]);
          const reviewBase = await git(bank.checkout, ["rev-parse", main]);
          const current = await readBankFiles(bank.checkout, main);
          const parsed = readBankMarkdown(current["BANK.md"] ?? "");
          const currentManifest = BankManifest.safeParse(parsed.ok ? parsed.data : null);
          // A migration cannot bootstrap its own authority; an invalid old manifest requires a manual merge.
          if (!currentManifest.success) return pending();
          const manifest = currentManifest.data;
          const owners = new Set((manifest.owners ?? []).map((owner) => owner.toLowerCase()));
          // Owners come from current main, never from the change requesting ownership.
          if (manifest.kind !== "team" || owners.size < 2) return pending();
          const author = pr.author?.toLowerCase();
          if (author === undefined) throw new Error("The forge omitted the pull request author.");
          step = "review";
          const reviews = valueOf(await options.forge.pullRequests.reviews(target));
          const latest = new Map<string, (typeof reviews)[number]>();
          for (const approval of [...reviews].sort((a, b) => a.id - b.id)) {
            if (approval.state !== "commented" && approval.state !== "pending") latest.set(approval.login.toLowerCase(), approval);
          }
          const approved = [...latest.values()].some((approval) => approval.state === "approved" && approval.commit === review.head && owners.has(approval.login.toLowerCase()) && approval.login.toLowerCase() !== author);
          if (!approved) return pending();
          step = "validate-check";
          const check = valueOf(await options.forge.pullRequests.validateCheck({ ...target, sha: review.head, signal: controller.signal }));
          if (check === "failure") throw new Error("The bank's validate check failed.");
          if (check !== "success") return pending();
          step = "validate-merge";
          await network("fetch", bank.checkout, [`+refs/heads/main:${REMOTE_MAIN}`]);
          // A moved main needs a fresh owner decision as well as a new combined-tree validation.
          if (await git(bank.checkout, ["rev-parse", main]) !== reviewBase) return pending();
          const combined = await detachedAt(reviewBase);
          await git(combined, ["-c", "user.name=Bank validation", "-c", "user.email=bank-validation@users.noreply", "merge", "--no-commit", "--no-ff", review.head]);
          const tree = await git(combined, ["write-tree"]);
          const verdict = validateBank({ files: await readBankFiles(bank.checkout, tree) });
          if (!verdict.valid) throw new Error(`The combined main refuses the changes: ${[...new Set(verdict.findings.filter((finding) => finding.severity === "refusal").map((finding) => finding.rule))].join(", ")}.`);
          await network("fetch", bank.checkout, [`+refs/heads/main:${REMOTE_MAIN}`]);
          if (await git(bank.checkout, ["rev-parse", main]) !== reviewBase) return pending();
          step = "merge";
          valueOf(await options.forge.pullRequests.merge({ ...target, expectedHead: review.head }));
        }
        step = "fetch-merged-main";
        const previous = await git(bank.checkout, ["rev-parse", "HEAD"]);
        await network("fetch", bank.checkout, [`+refs/heads/main:${REMOTE_MAIN}`]);
        const head = await git(bank.checkout, ["rev-parse", main]);
        return await finish(review.writes, review.drafts, head, previous);
      }
      step = "fetch";
      if (remote !== null) await network("fetch", bank.checkout, [`+refs/heads/main:${REMOTE_MAIN}`, `+refs/heads/memory/${(sessionId ?? bank.id).slice(0, 8)}-*:refs/remotes/origin/memory/${(sessionId ?? bank.id).slice(0, 8)}-*`]);
      const base = await git(bank.checkout, ["rev-parse", main]);
      if (changes?.expectedHead !== undefined && changes.expectedHead !== base) throw new Error("The bank main changed while the structural edit was prepared. Sync the bank and author the change again.");
      worktree = await detachedAt(base);
      step = "validate";
      const files = await readBankFiles(worktree);
      const writes: Record<string, string | null> = { ...changes?.writes };
      for (const change of drafts) {
        for (const path of change.removePaths ?? []) writes[path] = null;
        writes[change.path] = change.kind === "draft" ? change.content : null;
      }
      // The queue is persisted state, but no path from it may escape the detached worktree or traverse a symlink.
      const memories = new Set(bankTreeOf([...Object.keys(files), ...Object.keys(writes)]).memories.map(({ path }) => path));
      for (const path of Object.keys(writes)) {
        if ((changes === undefined && !memories.has(path)) || path.startsWith("/") || path.includes("\\") || path.split("/").some((part) => part === "." || part === ".." || part === "" || part === ".git")) throw new Error("A landing path is outside the bank's writable files.");
      }
      const secret = options.scrub.check(JSON.stringify({ drafts, writes, title: changes?.title, body: changes?.body }));
      if (secret !== null) throw new Error(`The queued changes contain a secret-shaped value (${secret}).`);
      const tree = await git(worktree, ["ls-tree", "-r", "-z", "HEAD"]);
      const links = tree.split("\0").filter((entry) => entry.startsWith("120000 ")).map((entry) => entry.slice(entry.indexOf("\t") + 1));
      if (Object.keys(writes).some((path) => links.some((link) => path === link || path.startsWith(`${link}/`)))) throw new Error("A queued path traverses a symbolic link.");
      const verdict = validateBank({ files, writes });
      if (!verdict.valid) throw new Error(`The current main refuses the changes: ${[...new Set(verdict.findings.filter((finding) => finding.severity === "refusal").map((finding) => finding.rule))].join(", ")}.`);
      const manifestFile = readBankMarkdown((changes === undefined ? files["BANK.md"] : writes["BANK.md"] ?? files["BANK.md"]) ?? "");
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
      if (changed) await git(worktree, ["-c", `user.name=${login}`, "-c", `user.email=${login.replace(/[^a-zA-Z0-9._-]/g, "-")}@users.noreply`, "commit", "--quiet", "-m", changes?.title ?? "Promote session memories."]);
      let head = await git(worktree, ["rev-parse", "HEAD"]);
      if (remote === null) {
        step = "land";
        await git(bank.checkout, ["update-ref", "refs/heads/main", head, base]);
      } else if (changed) {
        step = "push";
        const prefix = `memory/${(sessionId ?? bank.id).slice(0, 8)}-`;
        const refs = await git(bank.checkout, ["for-each-ref", "--format=%(refname:short)", "refs/heads/memory/", "refs/remotes/origin/memory/"]);
        let n = 1;
        while (refs.split("\n").some((ref) => ref === `${prefix}${n}` || ref === `origin/${prefix}${n}`)) n++;
        const branch = `${prefix}${n}`;
        await git(bank.checkout, ["branch", branch, head]);
        await network("push", worktree, [`HEAD:refs/heads/${branch}`]);
        step = "pull-request";
        const target = { origin: remote.origin, repository: remote.repository, purpose: "land session memories" };
        const pr = valueOf(await options.forge.pullRequests.create({ ...target, title: changes?.title ?? "Promote session memories", body: changes?.body ?? "Validated session drafts and retirements.", head: branch, base: "main" }));
        pullRequest = pr.url;
        const requiresReview = (policy: typeof manifest, override: BankEntry["mergeOverride"]) => {
          const orientation = new Set(policy.orientation);
          return changes !== undefined || policy.write.merge.memories !== "auto" || override === "review-memories"
            || drafts.some((draft) => orientation.has(draft.name) || [...(draft.removePaths ?? []), draft.path].some((path) => /\/decisions\//.test(path)));
        };
        const hold = (): MemoryPromoteResult => {
          options.log.atomically((tx) => options.log.append({ kind: ENVIRONMENT_STREAM_KIND, id: options.environmentId }, [
            { type: "bank.review-held", payload: { bankId: bank.id, sessionId, pullRequest, number: pr.number, head, writes, drafts: [...drafts] } },
            { type: "bank.awaiting-review", payload: { bankId: bank.id, sessionId, pullRequest } },
          ], { tx, actor: BANKS_ACTOR }));
          return { state: "awaiting-review", bank: bank.name, pullRequest: pr.url, files: Object.keys(writes).map((path) => ({ path, state: "pending" })) };
        };
        if (requiresReview(manifest, bank.mergeOverride)) return hold();
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
        // A check can take ten minutes: neither a stricter main policy nor a new user override may be bypassed.
        step = "fetch-merge-rule";
        await network("fetch", bank.checkout, [`+refs/heads/main:${REMOTE_MAIN}`]);
        const current = await readBankFiles(bank.checkout, main);
        const parsed = readBankMarkdown(current["BANK.md"] ?? "");
        const policy = BankManifest.parse(parsed.ok ? parsed.data : null);
        const registered = options.banks.entries().find(({ entry }) => entry.id === bank.id)?.entry;
        if (!registered?.enabled || registered.role !== "read-write") throw new Error("No writable bank is registered.");
        if (requiresReview(policy, registered.mergeOverride)) return hold();
        step = "merge";
        valueOf(await options.forge.pullRequests.merge({ ...target, number: pr.number, expectedHead: head }));
        step = "fetch-merged-main";
        await network("fetch", bank.checkout, [`+refs/heads/main:${REMOTE_MAIN}`]);
        head = await git(bank.checkout, ["rev-parse", main]);
      }
      return await finish(writes, drafts, head, base);
    } catch (error) {
      const reason = options.scrub.scrubOutput(error instanceof Error ? error.message : "Landing failed.");
      const last = options.banks.entries().find(({ entry }) => entry.id === bank.id)?.entry.status.landing;
      if (reviewReleased || last?.state !== "failed" || last.step !== step || last.reason !== reason) emit("bank.landing-failed", { step, reason, ...(reviewReleased ? { reviewReleased: true } : {}) });
      return { state: "failed", bank: bank.name, step, reason };
    } finally {
      if (worktree !== undefined) await runGit(bank.checkout, ["worktree", "remove", "--force", worktree], { maxBytes: 1024 * 1024 });
      if (root !== undefined) await rm(root, { recursive: true, force: true });
      busy.delete(bank.id);
    }
  };
  const track = (bankId: string, work: Promise<MemoryPromoteResult>) => {
    running.add(work);
    if (!active.has(bankId)) active.set(bankId, work);
    const finished = () => { running.delete(work); if (active.get(bankId) === work) active.delete(bankId); };
    void work.then(finished, finished);
    return work;
  };
  const interval = options.clock.setInterval(() => {
    for (const { entry } of options.banks.entries()) {
      if (entry.enabled) void lander.reconcile(entry).catch(() => undefined);
    }
  }, REVIEW_POLL_MS);
  const lander = {
    reconcile(bank: BankEntry): Promise<MemoryPromoteResult | null> {
      if (busy.has(bank.id)) return active.get(bank.id) ?? Promise.resolve(null);
      const review = heldReview(bank.id);
      return review === null ? Promise.resolve(null) : track(bank.id, promote(bank, review.sessionId, []));
    },
    promote(bank: BankEntry, sessionId: string, drafts: readonly BankDraft[]) {
      return track(bank.id, promote(bank, sessionId, drafts));
    },
    landChanges(bank: BankEntry, changes: BankChanges) {
      return track(bank.id, promote(bank, changes.sessionId ?? null, [], changes));
    },
    async close() { interval.cancel(); controller.abort(); await Promise.allSettled(running); stopFollowing(); },
  };
  return lander;
};
