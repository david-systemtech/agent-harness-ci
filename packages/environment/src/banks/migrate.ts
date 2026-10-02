import { readFile } from "node:fs/promises";
import { ContractError, ENVIRONMENT_STREAM_KIND, bankValidatorStamp } from "@agent-harness/contracts";
import { runGit } from "../workspace/git.js";
import type { ForgeService } from "../forge/forge-service.js";
import type { MethodHandlers } from "../serve/methods.js";
import { readBankFiles } from "./bank-files.js";
import type { BankService } from "./bank-service.js";
import { planBankMigration } from "./migration-planner.js";

/** Dry runs read committed blobs into a copy and never call the Lander or the forge. */
export const migrationMethods = (banks: BankService, environmentId: string, forges: Pick<ForgeService, "list">): MethodHandlers => ({
  "banks.migrate": {
    async prepare({ bankId, dryRun, choices = {} }) {
      const bank = banks.entries().find(({ entry }) => entry.id === bankId)?.entry;
      if (!bank) throw new ContractError({ code: "not_found", message: "The bank is not registered on this environment.", data: {} });
      if (!dryRun && bank.role === "read-only") throw new ContractError({ code: "bank_read_only", message: "The bank is read-only.", data: { bank: bank.name } });
      if (!dryRun && (!bank.enabled || bank.location.kind !== "remote")) throw new ContractError({ code: "invalid_params", message: "Preparing a migration PR requires an enabled remote bank; use a dry run for a local bank.", data: {} });
      const head = await runGit(bank.checkout, ["rev-parse", "HEAD"], { maxBytes: 1024 });
      if (!head.ok || head.truncated) throw new ContractError({ code: "invalid_params", message: "The committed bank head could not be read.", data: {} });
      const expectedHead = head.stdout.toString("utf8").trim();
      const source = await readBankFiles(bank.checkout, expectedHead, { allFiles: true });
      const validator = await readFile(new URL(import.meta.resolve("@agent-harness/contracts/bank-validator-file")), "utf8");
      if (!validator.startsWith(`${bankValidatorStamp()}\n`)) throw new ContractError({ code: "invalid_params", message: "Rebuild the bundled bank validator before planning a migration.", data: {} });
      const location = bank.location;
      const account = location.kind === "remote" ? forges.list().find((account) => account.origin === location.origin || account.aliases.some((alias) => alias.origin === location.origin && alias.verifiedAt !== null)) : null;
      const forge = account?.kind ?? (location.kind === "remote" && location.origin === "https://github.com" ? "github" : "forgejo");
      if (forge === "gitlab") throw new ContractError({ code: "invalid_params", message: "Bank migration on this forge is not supported.", data: {} });
      let plan: ReturnType<typeof planBankMigration>;
      try {
        plan = planBankMigration(source, choices, { name: bank.name, land: bank.location.kind === "remote" ? "pull-request" : "commit", forge, validator });
      } catch {
        throw new ContractError({ code: "invalid_params", message: "The accepted conversion choices conflict with the committed bank. Check the repairs and topic assignments.", data: {} });
      }
      if (location.kind === "remote" && account == null && location.origin !== "https://github.com") {
        plan.report.decisions.push({ path: "BANK.md", value: "forge-kind", reason: "Verify the forge account so the planner can select the bank's workflow format." });
        plan.report.valid = false;
      }
      if (!dryRun && plan.report.decisions.length > 0) throw new ContractError({ code: "invalid_params", message: "Resolve the decisions reported by a dry run before preparing a migration PR.", data: { decisions: plan.report.decisions } });
      if (!dryRun && !plan.report.valid) throw new ContractError({ code: "validation_failed", message: "The common bank validator refused the migration.", data: { rules: [...new Set(plan.report.findings.filter((finding) => finding.severity === "refusal").map((finding) => finding.rule))], findings: plan.report.findings } });
      const landing = dryRun || Object.keys(plan.writes).length === 0 ? null : await banks.landChanges(bank.id, { expectedHead, writes: plan.writes, title: "Migrate the bank to the shared structure contract", body: "Reviewed conversion with explicit repository mappings and accepted topic moves. Approve the orientation pointers and verify the bank's validate workflow before switch-over." });
      return () => ({ aggregate: { kind: ENVIRONMENT_STREAM_KIND, id: environmentId }, result: { report: plan.report, landing } });
    },
  },
});
