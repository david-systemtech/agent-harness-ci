import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BankManifest, CHECK_BUDGET_SECONDS, ContractError, ENVIRONMENT_STREAM_KIND, SHARED_BANK_RULES, invalidParams, normaliseRemote, type BankFinding, type BankJoinPreview } from "@agent-harness/contracts";
import { readBankMarkdown, validateBank } from "@agent-harness/contracts/bank-validator";
import type { ScrubRegistry } from "../scrub/registry.js";
import type { EventLog } from "../event-log/event-log.js";
import type { PreparedCommand } from "../serve/methods.js";
import type { ForgeService } from "../forge/forge-service.js";
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

/** A validated temporary clone, shallow and within the git budget for preview, full for joining. */
const withBankClone = async <Value>(options: Pick<BankJoinOptions, "forge" | "scrub">, url: string, shallow: boolean, use: (checkout: string, preview: BankJoinPreview) => Promise<Value>, signal?: AbortSignal): Promise<Value> => {
  const { forge, scrub } = options;
  const remote = normaliseRemote(url);
  if (remote?.path == null) throw new ContractError(invalidParams([], "The join URL must name a repository on a forge."));
  const capabilities = await forge.repositories.capabilities({ origin: url, repository: remote.path, purpose: "preview a memory bank", ...(signal !== undefined && { signal }) });
  if (capabilities.outcome === "refused") throw new ContractError(capabilities.error);
  if (capabilities.outcome === "unreachable") throw new ContractError({ code: "unreachable", message: capabilities.message, data: { origin: remote.origin } });
  if (capabilities.outcome === "done" && !capabilities.value.canRead) throw new ContractError({ code: "not_found", message: "This forge account cannot read the bank repository.", data: {} });
  if (capabilities.outcome === "failed") throw new ContractError({ code: "not_found", message: `The bank repository could not be read (HTTP ${capabilities.status}).`, data: {} });
  const directory = await mkdtemp(join(tmpdir(), "agent-harness-bank-preview-"));
  try {
    const cloned = await forge.git({ operation: "clone", repository: url, cwd: directory, directory: "bank", ...(shallow && { depth: 1, timeoutMs: CHECK_BUDGET_SECONDS.git * 1000 }), ...(signal !== undefined && { signal }), purpose: "preview a memory bank" });
    if (cloned.outcome === "refused") throw new ContractError(cloned.error);
    if (!cloned.git.ok) throw new ContractError({ code: "unreachable", message: "The bank's temporary clone could not be read.", data: { origin: remote.origin } });
    const files = await readBankFiles(join(directory, "bank"), "HEAD", signal === undefined ? {} : { signal });
    const verdict = validateBank({ files });
    if (!verdict.valid) throw new ContractError({ code: "validation_failed", message: "The bank does not pass validation.", data: { rules: [...new Set(verdict.findings.filter((finding) => finding.severity === "refusal").map((finding) => finding.rule))], findings: verdict.findings } });
    const secrets = Object.entries(files).flatMap(([path, text]): BankFinding[] => {
      const secret = scrub.check(text);
      return secret === null ? [] : [{ rule: "secret_shaped", severity: "refusal", path, field: "contents", secret, message: "The file holds a secret: move it to the key manager and name its path." }];
    });
    if (secrets.length > 0) throw new ContractError({ code: "validation_failed", message: "The bank holds a secret.", data: { rules: ["secret_shaped"], findings: secrets } });
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
    if (signal?.aborted === true && !(error instanceof ContractError)) throw new ContractError({ code: "unreachable", message: "The bank preview exceeded the git budget.", data: { origin: remote.origin } });
    throw error;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

/** A preview attaches nothing, and its temporary checkout is always removed. */
export const previewBank = async (options: Pick<BankJoinOptions, "forge" | "scrub">, url: string): Promise<BankJoinPreview> => {
  const remote = normaliseRemote(url);
  if (remote?.path == null) throw new ContractError(invalidParams([], "The join URL must name a repository on a forge."));
  const signal = AbortSignal.timeout(CHECK_BUDGET_SECONDS.git * 1000);
  const expired = new ContractError({ code: "unreachable", message: "The bank preview exceeded the git budget.", data: { origin: remote.origin } });
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
        return () => ({ aggregate: { kind: ENVIRONMENT_STREAM_KIND, id: options.environmentId }, rejected: { code: "conflict", message: `Another checkout is named ${preview.name}.`, data: { reason: "name_taken", name: preview.name } } });
      }
      throw error;
    }
    context.onUndo(() => rm(checkout, { recursive: true, force: true }));
    await cp(staged, checkout, { recursive: true });
    const registerParams = { commandId: params.commandId, bankId: params.bankId, path: checkout, role: preview.canPush ? "read-write" as const : "read-only" as const, accounts: params.accounts, repositories: params.repositories, defaultFor: [] };
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
