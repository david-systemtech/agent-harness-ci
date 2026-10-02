import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  bankValidatorStamp,
  bankValidatorWorkflow,
  ContractError,
  renderPersonalBank,
  renderTeamBank,
  VENDORED_VALIDATOR_PATH,
  type BankKeyManager,
  type ParamsOf,
} from "@agent-harness/contracts";
import { validateBank, type BankFiles } from "@agent-harness/contracts/bank-validator";
import type { ForgeService } from "../forge/forge-service.js";
import { secretShapedIn } from "../scrub/refusal.js";
import type { ScrubRegistry } from "../scrub/registry.js";
import type { PreparedCommand } from "../serve/methods.js";
import { runGit } from "../workspace/git.js";

/**
 * Creation's I/O, outside the registry transaction (ADR 0035, ADR 0037):
 * render and admit before creating a private repository, write its first
 * commit on main, push through the ForgeService's credential helper, then
 * register. The exclusive checkout directory reserves the bank's name;
 * a refused command removes only the directory it made. A remote created
 * before a failed push stays on the forge: deleting a repository is never
 * an implicit rollback.
 */
export interface BankCreationOptions {
  readonly dataDir: string;
  readonly localPersonName: string;
  readonly forge: Pick<ForgeService, "list" | "owners" | "repositories" | "git">;
  readonly scrub: Pick<ScrubRegistry, "check">;
  readonly keyManager: () => BankKeyManager | null;
  /** Admission before any repository is created, checked again by register at execute. */
  readonly admit: (bankId: string, name: string, files: BankFiles) => Promise<void>;
  /** Registry admission and event append, sharing register's rules. */
  readonly register: (params: ParamsOf<"banks.register">, personalDefaults: boolean) => ReturnType<PreparedCommand<"banks.register">["prepare"]>;
}

const invalid = (message: string): ContractError => new ContractError({ code: "invalid_params", message, data: { issues: [] } });
const collision = (name: string): ContractError => new ContractError({ code: "conflict", message: `Another bank or checkout is named ${name}.`, data: { reason: "name_taken", name } });

/** A local-only bank's follow-up collection, ready for Publish to move to a tracker. */
const LOCAL_ISSUES = `# Follow-ups\n\nKeep each follow-up in its own Markdown file, with evidence and this shape:\n\n## Problem\n\nDescribe what is broken or owed and the evidence that found it.\n\n## Done when\n\n- [ ] State the observable result that resolves the problem.\n\n## Verification\n\nRecord how the completed work was verified.\n`;

const git = async (checkout: string, args: string[]): Promise<void> => {
  const answer = await runGit(checkout, args, { maxBytes: 1024 * 1024 });
  if (!answer.ok) throw invalid(`Creating the bank failed at git ${args[0]}: ${answer.stderr}`);
};

export const createBankCommand = (options: BankCreationOptions): PreparedCommand<"banks.create"> => ({
  async prepare(params, context) {
    const input = params.creation;
    const secret = secretShapedIn(options.scrub, "bank", { creation: JSON.stringify(input), name: params.name }, "No bank was created.");
    if (secret !== null) throw new ContractError(secret);
    if (input.kind === "team" && new Set(input.projects.map((project) => project.folder)).size !== input.projects.length) throw invalid("Each first project needs a different folder.");
    const personal = input.kind === "personal";
    const local = personal && input.localOnly;
    const account = local ? null : options.forge.list().find((held) => (personal ? held.primary : held.id === input.forgeAccountId));
    if (!local && account == null) throw new ContractError({ code: "not_found", message: personal ? "No primary forge is set. Choose a primary forge or create a local-only bank." : "The selected forge account no longer exists.", data: {} });
    if (account != null && (account.identity === null || account.problem !== null)) throw invalid("Create a bank with a verified forge account: verify it in Set up, Forges first.");
    if (account?.kind === "gitlab") throw new ContractError({ code: "kind_unsupported", message: "Bank creation on GitLab is not available.", data: { origin: account.origin, kind: "gitlab" } });
    const owner = personal ? account?.identity?.login : input.owner.login;
    if (!personal && account != null) {
      const { owners } = await options.forge.owners(account.id);
      if (!owners.some((held) => held.login === input.owner.login && held.kind === input.owner.kind)) throw invalid("Choose the bank's owner from forge.orgs.list for the selected account.");
    }
    const repositoryName = personal ? params.name : input.repositoryName;
    const repository = account == null ? null : { forge: account.kind === "github" ? "GitHub" : account.kind === "forgejo" ? "Forgejo" : "Gitea", path: `${owner}/${repositoryName}` };
    const keyManager = options.keyManager();
    const personName = personal ? input.personName ?? account?.identity?.login ?? options.localPersonName : input.teamName;
    const files: Record<string, string> = {
      ...(personal
        ? renderPersonalBank({ name: params.name, person: { name: personName, login: account?.identity?.login ?? params.name }, org: input.org, project: input.project, repository, keyManager })
        : renderTeamBank({ name: params.name, team: { name: input.teamName, org: input.org }, projects: input.projects, owners: [account!.identity!.login], repository: repository!, keyManager })),
      ...(local && { "issues/README.md": LOCAL_ISSUES }),
    };
    const heldSecret = secretShapedIn(options.scrub, "bank", files, "No bank was created.");
    if (heldSecret !== null) throw new ContractError(heldSecret);
    const verdict = validateBank({ files });
    if (!verdict.valid) throw new ContractError({ code: "validation_failed", message: "The creation facts do not render a valid bank.", data: { rules: [...new Set(verdict.findings.filter((finding) => finding.severity === "refusal").map((finding) => finding.rule))], findings: verdict.findings } });
    await options.admit(params.bankId, params.name, files);
    const validator = await readFile(new URL(import.meta.resolve("@agent-harness/contracts/bank-validator-file")), "utf8");
    if (!validator.startsWith(`${bankValidatorStamp()}\n`)) throw invalid("The bundled bank validator's version does not match the contracts. Rebuild the validator.");
    files[VENDORED_VALIDATOR_PATH] = validator;
    if (account != null) {
      const workflow = bankValidatorWorkflow({ forge: account.kind });
      files[workflow.path] = workflow.text;
    }
    const checkout = join(options.dataDir, "banks", params.name);
    await mkdir(dirname(checkout), { recursive: true });
    try {
      await mkdir(checkout);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw collision(params.name);
      throw error;
    }
    context.onUndo(() => rm(checkout, { recursive: true, force: true }));
    for (const [path, text] of Object.entries(files)) {
      await mkdir(dirname(join(checkout, path)), { recursive: true });
      await writeFile(join(checkout, path), text);
    }
    await git(checkout, ["init", "--quiet", "--initial-branch=main"]);
    await git(checkout, ["add", "--all"]);
    const login = account?.identity?.login ?? personName;
    await git(checkout, ["-c", `user.name=${login}`, "-c", `user.email=${login.replace(/[^a-zA-Z0-9._-]/g, "-")}@users.noreply`, "commit", "--quiet", "-m", "Create the memory bank."]);
    if (account != null && repository != null) {
      const answer = await options.forge.repositories.create({ origin: account.origin, purpose: "create a memory bank", ...(personal || input.owner.kind === "user" ? {} : { organisation: owner! }), name: repositoryName, private: true });
      if (answer.outcome === "refused") throw new ContractError(answer.error);
      if (answer.outcome === "unreachable") throw new ContractError({ code: "unreachable", message: answer.message, data: { origin: account.origin } });
      if (answer.outcome === "failed") throw new ContractError({ code: "verification_failed", message: answer.message, data: { origin: account.origin, status: answer.status } });
      const url = `${account.origin}/${repository.path}.git`;
      await git(checkout, ["remote", "add", "origin", url]);
      const pushed = await options.forge.git({ operation: "push", repository: url, cwd: checkout, refspecs: ["HEAD:refs/heads/main"], purpose: "push a memory bank's first commit" });
      if (pushed.outcome === "refused") throw new ContractError(pushed.error);
      if (!pushed.git.ok) throw invalid(`The bank's private repository ${repository.path} was created, but its first push failed: ${pushed.git.stderr}`);
    }
    const registration: ParamsOf<"banks.register"> = { commandId: params.commandId, bankId: params.bankId, path: checkout, role: "read-write", accounts: "all", repositories: "all", defaultFor: [] };
    const handler = await options.register(registration, personal);
    return (_params, command) => handler(registration, command);
  },
});
