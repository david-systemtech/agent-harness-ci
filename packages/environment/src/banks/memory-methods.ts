import { ContractError, type Scope } from "@agent-harness/contracts";
import type { MethodContext, MethodHandlers } from "../serve/methods.js";
import type { MemoryCaller, MemoryOperations } from "./memory-operations.js";

/** Only a client on this machine asks as the CLI's `bank` verbs do: a local client session, the bootstrap grant's. */
const localOnly = (context: MethodContext, scope: Scope): void => {
  if (context.clientSession.local) return;
  throw new ContractError({
    code: "forbidden",
    message: "Only a local client session may use the memory tools from outside the harness: the bank verbs of the CLI on this machine.",
    data: { scope, reason: "local" },
  });
};

/**
 * The `banks.memory.*` methods (banks spec, "CLI"; #1044): the memory
 * operations a run's tools use, for the CLI's `bank` verbs on this machine.
 * The caller's banks are those in scope for the environment's default
 * account (ADR 0018) and the repository it names; its drafts join the queue
 * it names, its own session's; its calls record no session's recent use.
 */
export const memoryMethods = (operations: MemoryOperations, defaultAccount: () => string | null): MethodHandlers => {
  const caller = (repositoryIdentity: string | null): MemoryCaller => ({ accountId: defaultAccount(), repositoryIdentity });
  return {
    "banks.memory.search": async ({ repositoryIdentity, ...input }, context) => {
      localOnly(context, "read");
      return { text: await operations.search(caller(repositoryIdentity), input) };
    },
    "banks.memory.read": async ({ repositoryIdentity, ...input }, context) => {
      localOnly(context, "read");
      return { text: await operations.read(caller(repositoryIdentity), input) };
    },
    "banks.memory.draft": async ({ repositoryIdentity, queue, ...input }, context) => {
      localOnly(context, "admin");
      return operations.draft({ ...caller(repositoryIdentity), queue }, input);
    },
    "banks.memory.promote": async ({ repositoryIdentity, queue, ...input }, context) => {
      localOnly(context, "admin");
      return { promotion: await operations.promote({ ...caller(repositoryIdentity), queue }, input) };
    },
  };
};
