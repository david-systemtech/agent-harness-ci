import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { bankValidatorStamp, bankValidatorWorkflow, ContractError, VENDORED_VALIDATOR_PATH, type BankEntry, type BankReviewHeldPayload, type ResultOf } from "@agent-harness/contracts";
import { BankManifest } from "@agent-harness/contracts";
import { readBankMarkdown, validateBank } from "@agent-harness/contracts/bank-validator";
import { stringify } from "yaml";
import type { ForgeService } from "../forge/forge-service.js";
import type { ForgeAnswer } from "../forge/operations.js";
import type { ScrubRegistry } from "../scrub/registry.js";
import { runGit } from "../workspace/git.js";
import { readBankFiles } from "./bank-files.js";
import { accountNeedsFix, invalid, MISSING_PART, repositoryNotMade, secretRefusal } from "./create.js";

/** What the forge answered, else its refusal in setup-copy.md §5.8's words: `failed` says what the forge did not do. */
const valueOf = <T>(answer: ForgeAnswer<T>, origin: string, failed: (status: number, message: string) => ContractError = (status, message) => repositoryNotMade(origin, { outcome: "failed", status, message })): T => {
  if (answer.outcome === "done") return answer.value;
  if (answer.outcome === "refused") throw new ContractError(answer.error);
  if (answer.outcome === "unreachable") throw repositoryNotMade(origin, answer);
  throw failed(answer.status, answer.message);
};

/** Prepares publication without writing the attached checkout's memories or manifest. The caller reserves landing and commits the registry/review events with the receipt. */
export const prepareBankPublication = async (options: {
  bank: BankEntry; commandId: string; transferIssues: boolean; dataDir: string;
  forge: Pick<ForgeService, "list" | "repositories" | "pullRequests" | "issues" | "git">;
  scrub: Pick<ScrubRegistry, "check">;
}) => {
  const { bank, forge } = options;
  const account = forge.list().find((held) => held.primary);
  if (!account) throw new ContractError({ code: "no_primary_forge", message: "Choose your main forge before you move this notebook to it.", data: { step: "forges" } });
  if (account.identity === null || account.problem !== null) throw accountNeedsFix(account);
  if (account.kind === "gitlab") throw new ContractError({ code: "kind_unsupported", message: "GitLab is not supported yet.", data: { origin: account.origin, kind: "gitlab" } });
  const origin = account.origin;
  const host = new URL(origin).host;
  /** The refusal of a review or follow-up the forge did not take. */
  const notTaken = (status: number, message: string) =>
    new ContractError({ code: "verification_failed", message: `${host} did not accept the move of ${bank.name}. Try again in a moment.`, data: { origin, status, details: [message] } });
  /** The refusal of a description that cannot move to the forge. */
  const descriptionCannotMove = `${bank.name} needs a working description before it can move to your forge.`;
  const repository = `${account.identity.login}/${bank.name}`;
  const url = `${origin}/${repository}.git`;
  const target = { origin, repository, purpose: "publish a local memory bank" };
  const git = async (cwd: string, args: string[]) => {
    const result = await runGit(cwd, args, { maxBytes: 64 * 1024 * 1024 });
    if (!result.ok || result.truncated) throw invalid(`agent-harness could not get ${bank.name} ready to move.`, [`git ${args[0]}: ${result.stderr}`]);
    return result.stdout.toString("utf8");
  };
  const rootDir = join(options.dataDir, "bank-publications");
  await mkdir(rootDir, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(rootDir, "publish-"));
  try {
    const checkout = join(root, "checkout");
    await git(root, ["clone", "--no-hardlinks", "--single-branch", "--branch", "main", bank.checkout, checkout]);
    const base = (await git(checkout, ["rev-parse", "HEAD"])).trim();
    const files = await readBankFiles(checkout);
    const parsed = readBankMarkdown(files["BANK.md"] ?? "");
    const manifest = BankManifest.safeParse(parsed.ok ? parsed.data : null);
    if (!parsed.ok || !manifest.success || manifest.data.kind !== "personal") throw invalid(descriptionCannotMove, ["Publish needs a valid personal bank manifest."]);
    // Preserve authored body and frontmatter facts; only landing changes.
    const writes: Record<string, string> = { "BANK.md": `---\n${stringify({ ...parsed.data, write: { ...manifest.data.write, land: "pull-request" } })}---\n${parsed.body}` };
    const workflow = bankValidatorWorkflow({ forge: account.kind });
    writes[workflow.path] = workflow.text;
    const validator = await readFile(new URL(import.meta.resolve("@agent-harness/contracts/bank-validator-file")), "utf8");
    if (!validator.startsWith(`${bankValidatorStamp()}\n`)) throw invalid(MISSING_PART, ["The bundled bank validator's version does not match the contracts."]);
    writes[VENDORED_VALIDATOR_PATH] = validator;
    const verdict = validateBank({ files: { ...files, "BANK.md": writes["BANK.md"]! } });
    if (!verdict.valid) throw new ContractError({ code: "validation_failed", message: descriptionCannotMove, data: { rules: [...new Set(verdict.findings.filter((f) => f.severity === "refusal").map((f) => f.rule))], findings: verdict.findings } });
    const followUps: ResultOf<"banks.publish">["followUps"] = [];
    const listing = (await git(checkout, ["ls-tree", "-r", "-z", "HEAD", "--", "issues"])).split("\0");
    for (const entry of listing) {
      const tab = entry.indexOf("\t");
      const path = entry.slice(tab + 1);
      if (!/^100(?:644|755) blob /.test(entry) || !path.endsWith(".md") || path.toLowerCase() === "issues/readme.md") continue;
      const body = await git(checkout, ["show", `HEAD:${path}`]);
      const title = /^#\s+(.+)$/m.exec(body)?.[1]?.trim() ?? path.slice(7, -3);
      followUps.push({ path, title, body, issue: null });
    }
    const secret = secretRefusal(options.scrub, { ...files, ...Object.fromEntries(followUps.map((f) => [f.path, f.body])) }, `${bank.name} holds something that looks like a password. Take it out before it moves to your forge.`);
    if (secret !== null) throw secret;
    const branch = `memory/publish-${options.commandId}`;
    await git(checkout, ["checkout", "-b", branch]);
    for (const [path, content] of Object.entries(writes)) {
      const parts = path.split("/");
      let directory = checkout;
      for (const part of parts.slice(0, -1)) {
        directory = join(directory, part);
        const stat = await lstat(directory).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
        if (stat === null) await mkdir(directory);
        else if (!stat.isDirectory() || stat.isSymbolicLink()) throw invalid(`A file in ${bank.name}'s folder is not a plain file, so it cannot move.`, [`${parts.slice(0, -1).join("/")} is not a directory.`]);
      }
      const destination = join(checkout, path);
      const stat = await lstat(destination).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
      if (stat !== null && (!stat.isFile() || stat.isSymbolicLink())) throw invalid(`A file in ${bank.name}'s folder is not a plain file, so it cannot move.`, [`${path} is not a regular file.`]);
      await writeFile(destination, content);
    }
    await git(checkout, ["add", "--all"]);
    const login = account.identity.login;
    await git(checkout, ["-c", `user.name=${login}`, "-c", `user.email=${login.replace(/[^a-zA-Z0-9._-]/g, "-")}@users.noreply`, "commit", "--quiet", "-m", "Review the published bank's landing policy."]);
    const head = (await git(checkout, ["rev-parse", "HEAD"])).trim();
    valueOf(await forge.repositories.create({ origin, purpose: target.purpose, name: bank.name, private: true }), origin);
    await git(checkout, ["remote", "set-url", "origin", url]);
    const push = async (refspec: string) => {
      const pushed = await forge.git({ operation: "push", repository: url, cwd: checkout, refspecs: [refspec], purpose: target.purpose });
      if (pushed.outcome === "refused") throw new ContractError(pushed.error);
      if (!pushed.git.ok || pushed.git.truncated) {
        throw invalid(`The repository was made on ${host}, but agent-harness could not copy ${bank.name} to it.`, [`${repository}: git push ${refspec} exited ${pushed.git.code ?? "without a code"}.`]);
      }
    };
    await push(`${base}:refs/heads/main`);
    await push(`HEAD:refs/heads/${branch}`);
    const pr = valueOf(await forge.pullRequests.create({ ...target, title: "Review the published bank's landing policy", body: "Preserve the local bank's history and review its switch to pull-request landing and bank validation.", head: branch, base: "main" }), origin, notTaken);
    if (options.transferIssues) {
      for (const followUp of followUps) followUp.issue = valueOf(await forge.issues.create({ ...target, title: followUp.title, body: followUp.body }), origin, notTaken).url;
    }
    // Fetch the held commit into the owned checkout: the Lander verifies its exact files after owner review.
    const fetched = await forge.git({ operation: "fetch", repository: url, cwd: bank.checkout, refspecs: ["+refs/heads/main:refs/remotes/origin/main", `+refs/heads/${branch}:refs/remotes/origin/${branch}`], purpose: target.purpose });
    if (fetched.outcome === "refused") throw new ContractError(fetched.error);
    if (!fetched.git.ok || fetched.git.truncated) throw invalid(`${bank.name} is on ${host}, but agent-harness could not read it back for your review. Choose Check again.`, [`git fetch exited ${fetched.git.code ?? "without a code"}.`]);
    const review: BankReviewHeldPayload = { bankId: bank.id, sessionId: null, pullRequest: pr.url, number: pr.number, head, writes, drafts: [] };
    return { location: { kind: "remote" as const, origin, repository }, review, followUps, url };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};
