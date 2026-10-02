import { readFile } from "node:fs/promises";
import { BANK_VALIDATOR, VENDORED_VALIDATOR_PATH, ContractError, ENVIRONMENT_STREAM_KIND, bankValidatorStamp, bankValidatorStatus } from "@agent-harness/contracts";
import { runGit } from "../workspace/git.js";
import type { MethodHandlers } from "../serve/methods.js";
import type { BankService } from "./bank-service.js";
import { readBankFiles } from "./bank-files.js";

/** All git and forge work runs in prepare, outside the receipt transaction. */
export const validatorUpdateMethods = (banks: BankService, environmentId: string): MethodHandlers => ({
  "banks.validator.update": {
    async prepare({ bankId }) {
      const bank = banks.entries().find(({ entry }) => entry.id === bankId)?.entry;
      if (!bank) throw new ContractError({ code: "not_found", message: "The bank is not registered on this environment.", data: {} });
      if (!bank.enabled || bank.role !== "read-write") throw new ContractError({ code: "bank_read_only", message: "Enable a writable bank before updating its validator.", data: { bank: bank.name } });
      const reconciled = await banks.reconcileLanding(bankId, [VENDORED_VALIDATOR_PATH]);
      if (reconciled !== null) {
        if (reconciled.state !== "failed" && (reconciled.files.length !== 1 || reconciled.files[0]?.path !== VENDORED_VALIDATOR_PATH)) throw new ContractError({ code: "conflict", message: "Another reviewed change is awaiting reconciliation for this bank.", data: { reason: "landing_in_progress", bankId } });
        return () => ({ aggregate: { kind: ENVIRONMENT_STREAM_KIND, id: environmentId }, result: { version: BANK_VALIDATOR.version, landing: reconciled } });
      }
      const head = await runGit(bank.checkout, ["rev-parse", "HEAD"], { maxBytes: 1024 });
      if (!head.ok || head.truncated) throw new ContractError({ code: "invalid_params", message: "The committed bank head could not be read.", data: {} });
      const expectedHead = head.stdout.toString("utf8").trim();
      const files = await readBankFiles(bank.checkout, expectedHead);
      if (!bankValidatorStatus(files[VENDORED_VALIDATOR_PATH]).needsUpdate) return () => ({ aggregate: { kind: ENVIRONMENT_STREAM_KIND, id: environmentId }, result: { version: BANK_VALIDATOR.version, landing: null } });
      const validator = await readFile(new URL(import.meta.resolve("@agent-harness/contracts/bank-validator-file")), "utf8");
      if (!validator.startsWith(`${bankValidatorStamp()}\n`)) throw new ContractError({ code: "invalid_params", message: "Rebuild the bundled bank validator before updating a bank.", data: {} });
      const landing = await banks.landChanges(bankId, {
        expectedHead, writes: { [VENDORED_VALIDATOR_PATH]: validator },
        title: `Update the bank validator to version ${BANK_VALIDATOR.version}`,
        body: "Replace the vendored validator with the environment's built contracts artefact. The bank's validation workflow and secret scan remain in place. Review and land through the bank's owner rules.",
      });
      return () => ({ aggregate: { kind: ENVIRONMENT_STREAM_KIND, id: environmentId }, result: { version: BANK_VALIDATOR.version, landing } });
    },
  },
});
