import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BankManifest, CHECK_BUDGET_SECONDS, ContractError, ENVIRONMENT_STREAM_KIND, SHARED_BANK_RULES, invalidParams, normaliseRemote, type BankFinding, type BankJoinPreview } from "@agent-harness/contracts";
import { readBankMarkdown, validateBank } from "@agent-harness/contracts/bank-validator";
import type { ScrubRegistry } from "../scrub/registry.js";
import type { EventLog } from "../event-log/event-log.js";
import type { PreparedCommand } from "../serve/methods.js";
import type { ForgeService } from "../forge/forge-service.js";
import type { ForgeAnswer } from "../forge/operations.js";
import type { ForgeRepositoryCapabilities } from "../forge/providers.js";
import { readBankFiles } from "./bank-files.js";
import { indexBank } from "./bank-index.js";
import { renderFixedTiers } from "./index-renderer.js";

interface BankJoinOptions {
  readonly forge: Pick<ForgeService, "repositories" | "git">;
  readonly scrub: Pick<ScrubRegistry, "check">;
  readonly dataDir: string;
  readonly register: PreparedCommand<"banks.register">;
  readonly log: EventLog;
  readonly environmentId: string;
}

/** The refusal of a link that names no repository on a forge (setup-copy.md §5.8). */
const NOT_A_NOTEBOOK_LINK = "That is not a notebook link. Paste the link an owner shared with you.";

/** The refusal of a preview or join the git budget ran out on. */
const tooSlow = (origin: string): ContractError =>
  new ContractError({ code: "unreachable", message: "Reading the notebook took too long. Try again.", data: { origin, details: [`The preview passed the ${CHECK_BUDGET_SECONDS.git}-second budget.`] } });

/**
 * Why the forge did not let this link be read, in setup-copy.md §5.8's words, its own words in details (#1854): a
 * forge that refused an anonymous read cannot say whether the repository is private or not there; one read with a
 * forge account can.
 */
const unreadable = (origin: string, answer: Exclude<ForgeAnswer<ForgeRepositoryCapabilities>, { outcome: "done" }>): ContractError => {
  const host = new URL(origin).host;
  switch (answer.outcome) {
    case "refused":
      return answer.error.code === "forge_account_missing"
        ? new ContractError({ ...answer.error, message: `agent-harness cannot see a notebook at this link. If it is private, add a forge for ${host} first.`, data: { ...answer.error.data, details: [answer.error.message] } })
        : new ContractError(answer.error);
    case "unreachable":
      return new ContractError({ code: "unreachable", message: `agent-harness could not reach ${host}. Check the link and the internet connection.`, data: { origin, details: [answer.message] } });
    case "failed":
      return new ContractError({
        code: "not_found",
        message: answer.status === 404 ? "There is no notebook at this link. Check it with whoever shared it." : `${host} would not show this notebook to agent-harness. Try again in a moment.`,
        data: { status: answer.status, details: [answer.message] },
      });
  }
};

/** A validated temporary clone, shallow and within the git budget for preview, full for joining. */
const withBankClone = async <Value>(options: Pick<BankJoinOptions, "forge" | "scrub">, url: string, shallow: boolean, use: (checkout: string, preview: BankJoinPreview) => Promise<Value>, signal?: AbortSignal): Promise<Value> => {
  const { forge, scrub } = options;
  const purpose = shallow ? "preview a memory bank" : "join a memory bank";
  const remote = normaliseRemote(url);
  if (remote?.path == null) throw new ContractError(invalidParams([], NOT_A_NOTEBOOK_LINK));
  const capabilities = await forge.repositories.capabilities({ origin: url, repository: remote.path, purpose, ...(signal !== undefined && { signal }) });
  if (capabilities.outcome !== "done") throw unreadable(remote.origin, capabilities);
  if (!capabilities.value.canRead) throw new ContractError({ code: "not_found", message: "Your forge account cannot read this notebook. Ask an owner to add you.", data: {} });
  const directory = await mkdtemp(join(tmpdir(), "agent-harness-bank-preview-"));
  try {
    const cloned = await forge.git({ operation: "clone", repository: url, cwd: directory, directory: "bank", ...(shallow && { depth: 1, timeoutMs: CHECK_BUDGET_SECONDS.git * 1000 }), ...(signal !== undefined && { signal }), purpose });
    if (cloned.outcome === "refused") throw new ContractError(cloned.error);
    if (!cloned.git.ok) {
      throw new ContractError({ code: "unreachable", message: `agent-harness could not copy this notebook from ${new URL(remote.origin).host}. Try again in a moment.`, data: { origin: remote.origin, details: [`git clone exited ${cloned.git.code ?? "without a code"}.`] } });
    }
    const files = await readBankFiles(join(directory, "bank"), "HEAD", signal === undefined ? {} : { signal });
    const verdict = validateBank({ files });
    if (!verdict.valid) throw new ContractError({ code: "validation_failed", message: "This notebook's description has a problem, so it cannot be joined. Ask an owner to fix it.", data: { rules: [...new Set(verdict.findings.filter((finding) => finding.severity === "refusal").map((finding) => finding.rule))], findings: verdict.findings } });
    const secrets = Object.entries(files).flatMap(([path, text]): BankFinding[] => {
      const secret = scrub.check(text);
      return secret === null ? [] : [{ rule: "secret_shaped", severity: "refusal", path, field: "contents", secret, message: "The file holds a secret: move it to the key manager and name its path." }];
    });
    if (secrets.length > 0) throw new ContractError({ code: "validation_failed", message: "This notebook holds something that looks like a password, so it cannot be joined. Ask an owner to remove it.", data: { rules: ["secret_shaped"], findings: secrets } });
    const markdown = readBankMarkdown(files["BANK.md"] ?? "");
    const manifest = BankManifest.parse(markdown.ok ? markdown.data : {});
    const index = indexBank({ name: manifest.name, kind: manifest.kind, role: capabilities.value.canPush ? "read-write" : "read-only", files });
    const preview: BankJoinPreview = {
      name: manifest.name, kind: manifest.kind, line: renderFixedTiers(index).text.split("\n")[0] ?? "",
      orgs: index.orgs.map(({ path, line }) => ({ path, line })),
      projects: index.orgs.flatMap((org) => org.folders.filter((folder) => folder.path.split("/").length === 3).map(({ path, line }) => ({ path, line }))),
      entities: manifest.entities, orientation: manifest.orientation, owners: manifest.owners ?? [], merge: manifest.write.merge,
      rules: manifest.kind === "team" ? [...SHARED_BANK_RULES] : [], ...capabilities.value,
    };
    return await use(join(directory, "bank"), preview);
  } catch (error) {
    if (signal?.aborted === true && !(error instanceof ContractError)) throw tooSlow(remote.origin);
    throw error;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

/** A preview attaches nothing, and its temporary checkout is always removed. */
export const previewBank = async (options: Pick<BankJoinOptions, "forge" | "scrub">, url: string): Promise<BankJoinPreview> => {
  const remote = normaliseRemote(url);
  if (remote?.path == null) throw new ContractError(invalidParams([], NOT_A_NOTEBOOK_LINK));
  const signal = AbortSignal.timeout(CHECK_BUDGET_SECONDS.git * 1000);
  const expired = tooSlow(remote.origin);
  let stop!: () => void;
  const budget = new Promise<never>((_resolve, reject) => {
    stop = () => reject(expired);
    signal.addEventListener("abort", stop, { once: true });
  });
  try {
    // Credential resolution and origin detection share the budget with git, even if they cannot yet be canceled.
    return await Promise.race([withBankClone(options, url, true, async (_checkout, preview) => preview, signal), budget]);
  } finally {
    signal.removeEventListener("abort", stop);
  }
};

/** A full clone is prepared before the registry transaction; dispatch removes owned files on rejection. */
export const joinBank = (options: BankJoinOptions): PreparedCommand<"banks.join"> => ({
  prepare: (params, context) => withBankClone(options, params.url, false, async (staged, preview) => {
    const root = join(options.dataDir, "banks");
    await mkdir(root, { recursive: true });
    const checkout = join(root, preview.name);
    try {
      // Exclusive ownership: a concurrent join must never remove another join's checkout.
      await mkdir(checkout);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") {
        return () => ({ aggregate: { kind: ENVIRONMENT_STREAM_KIND, id: options.environmentId }, rejected: { code: "conflict", message: `You already have a notebook named ${preview.name}.`, data: { reason: "name_taken", name: preview.name } } });
      }
      throw error;
    }
    context.onUndo(() => rm(checkout, { recursive: true, force: true }));
    await cp(staged, checkout, { recursive: true });
    const registerParams = { commandId: params.commandId, bankId: params.bankId, path: checkout, role: preview.canPush ? "read-write" as const : "read-only" as const, accounts: params.accounts, repositories: params.repositories, defaultFor: [], ...(params.copiedFrom !== undefined && { copiedFrom: params.copiedFrom }) };
    const register = await options.register.prepare(registerParams, context);
    return (_params, command) => {
      const answer = register(registerParams, command);
      if (answer.rejected === undefined) {
        options.log.append(answer.aggregate, [{ type: "bank.updated", payload: { bankId: params.bankId } }], { tx: command.tx, actor: command.actor, commandId: command.commandId });
      }
      return answer;
    };
  }),
});
