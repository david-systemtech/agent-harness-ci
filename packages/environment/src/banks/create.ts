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
  type ForgeAccountRecord,
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

/** A refusal in setup-copy.md §5.8's words, the raw facts behind it in details. */
export const invalid = (message: string, details: readonly string[] = []): ContractError =>
  new ContractError({ code: "invalid_params", message, data: { issues: [], ...(details.length > 0 && { details }) } });
const collision = (name: string): ContractError =>
  new ContractError({ code: "conflict", message: `You already have a notebook or folder named ${name}. Choose another name.`, data: { reason: "name_taken", name } });

/** The refusal of a forge account not verified, or with a problem, to create or publish a notebook on. */
export const accountNeedsFix = (account: Pick<ForgeAccountRecord, "origin" | "problem">): ContractError =>
  invalid(`Your account on ${new URL(account.origin).host} needs a fix first.`, [account.problem?.message ?? "The forge account is not verified yet."]);

/**
 * The refusal of a secret among `fields`, in setup-copy.md §5.8's words: which answer or file held it stays in
 * `data.field`, never in the line; null when none holds one.
 */
export const secretRefusal = (scrub: Pick<ScrubRegistry, "check">, fields: Readonly<Record<string, string>>, message: string): ContractError | null => {
  const found = secretShapedIn(scrub, "notebook", fields, "");
  return found === null ? null : new ContractError({ ...found, message });
};

/** The refusal of answers that hold, or render a notebook that holds, a secret. */
const ANSWERS_HOLD_A_SECRET = "Your answers hold something that looks like a password. Take it out and try again.";

/** The refusal of a notebook whose bundled validator is not this build's. */
export const MISSING_PART = "This copy of agent-harness is missing a part. Reinstall agent-harness.";

/** A local-only bank's follow-up collection, ready for Publish to move to a tracker. */
const LOCAL_ISSUES = `# Follow-ups\n\nKeep each follow-up in its own Markdown file, with evidence and this shape:\n\n## Problem\n\nDescribe what is broken or owed and the evidence that found it.\n\n## Done when\n\n- [ ] State the observable result that resolves the problem.\n\n## Verification\n\nRecord how the completed work was verified.\n`;

/** The refusal of a repository the forge did not make, for creating or publishing a notebook: its words in details. */
export const repositoryNotMade = (origin: string, answer: { readonly outcome: "unreachable"; readonly message: string } | { readonly outcome: "failed"; readonly status: number; readonly message: string }): ContractError => {
  const host = new URL(origin).host;
  return answer.outcome === "unreachable"
    ? new ContractError({ code: "unreachable", message: `agent-harness could not reach ${host}. Check the internet connection, then try again.`, data: { origin, details: [answer.message] } })
    : new ContractError({ code: "verification_failed", message: `${host} did not make the notebook's repository. Check that your token can create repositories.`, data: { origin, status: answer.status, details: [answer.message] } });
};

const git = async (checkout: string, args: string[]): Promise<void> => {
  const answer = await runGit(checkout, args, { maxBytes: 1024 * 1024 });
  if (!answer.ok) throw invalid("agent-harness could not set up the notebook's folder on this computer.", [`git ${args[0]}: ${answer.stderr}`]);
};

export const createBankCommand = (options: BankCreationOptions): PreparedCommand<"banks.create"> => ({
  async prepare(params, context) {
    const input = params.creation;
    const secret = secretRefusal(options.scrub, { creation: JSON.stringify(input), name: params.name }, ANSWERS_HOLD_A_SECRET);
    if (secret !== null) throw secret;
    if (input.kind === "team" && new Set(input.projects.map((project) => project.folder)).size !== input.projects.length) throw invalid("Enter a different folder name for each project.");
    const personal = input.kind === "personal";
    const local = personal && input.localOnly;
    const account = local ? null : options.forge.list().find((held) => (personal ? held.primary : held.id === input.forgeAccountId));
    if (!local && account == null) throw new ContractError({ code: "not_found", message: personal ? "Choose your main forge first, or keep the notebook on this computer." : "That forge account is no longer connected. Choose another one.", data: {} });
    if (account != null && (account.identity === null || account.problem !== null)) throw accountNeedsFix(account);
    if (account?.kind === "gitlab") throw new ContractError({ code: "kind_unsupported", message: "GitLab is not supported yet.", data: { origin: account.origin, kind: "gitlab" } });
    const owner = personal ? account?.identity?.login : input.owner.login;
    if (!personal && account != null) {
      const { owners } = await options.forge.owners(account.id);
      if (!owners.some((held) => held.login === input.owner.login && held.kind === input.owner.kind)) throw invalid("Choose the owner from the list.", [`${input.owner.kind} ${input.owner.login} is not an owner forge.orgs.list offers for this account.`]);
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
    const heldSecret = secretRefusal(options.scrub, files, ANSWERS_HOLD_A_SECRET);
    if (heldSecret !== null) throw heldSecret;
    const verdict = validateBank({ files });
    if (!verdict.valid) throw new ContractError({ code: "validation_failed", message: "These answers do not make a notebook agent-harness can use. Check the names and try again.", data: { rules: [...new Set(verdict.findings.filter((finding) => finding.severity === "refusal").map((finding) => finding.rule))], findings: verdict.findings } });
    await options.admit(params.bankId, params.name, files);
    const validator = await readFile(new URL(import.meta.resolve("@agent-harness/contracts/bank-validator-file")), "utf8");
    if (!validator.startsWith(`${bankValidatorStamp()}\n`)) throw invalid(MISSING_PART, ["The bundled bank validator's version does not match the contracts."]);
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
      if (answer.outcome !== "done") throw repositoryNotMade(account.origin, answer);
      const url = `${account.origin}/${repository.path}.git`;
      await git(checkout, ["remote", "add", "origin", url]);
      const pushed = await options.forge.git({ operation: "push", repository: url, cwd: checkout, refspecs: ["HEAD:refs/heads/main"], purpose: "push a memory bank's first commit" });
      if (pushed.outcome === "refused") throw new ContractError(pushed.error);
      if (!pushed.git.ok) {
        throw invalid(`The repository was made on ${new URL(account.origin).host}, but agent-harness could not save the notebook to it.`, [`${repository.path}: git push exited ${pushed.git.code ?? "without a code"}.`]);
      }
    }
    const registration: ParamsOf<"banks.register"> = { commandId: params.commandId, bankId: params.bankId, path: checkout, role: "read-write", accounts: "all", repositories: "all", defaultFor: [] };
    const handler = await options.register(registration, personal);
    return (_params, command) => handler(registration, command);
  },
});
