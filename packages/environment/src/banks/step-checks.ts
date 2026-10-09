import { memoryBankHealth } from "@agent-harness/contracts";
import type { StateChecker } from "../setup/check.js";
import type { BankRecords } from "./records.js";

/** Verify the enabled banks on the environment; the step and each bank card share the words for those recorded facts. */
export const memoryBankStateChecks = (banks: BankRecords): { readonly [Id in keyof typeof memoryBankHealth]: StateChecker } => ({
  "memory-bank.present": () => memoryBankHealth["memory-bank.present"](banks.list()),
  "memory-bank.reachable": async () => memoryBankHealth["memory-bank.reachable"](await banks.verify()),
  "memory-bank.manifest": async () => memoryBankHealth["memory-bank.manifest"](await banks.verify()),
  "memory-bank.orientation": async () => memoryBankHealth["memory-bank.orientation"](await banks.verify()),
  "memory-bank.owners": async () => memoryBankHealth["memory-bank.owners"](await banks.verify()),
  "memory-bank.landing": async () => memoryBankHealth["memory-bank.landing"](await banks.verify()),
});
