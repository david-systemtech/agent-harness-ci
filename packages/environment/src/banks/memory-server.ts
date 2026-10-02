import { z } from "zod";
import { ContractError, MemoryDraftInput, MemoryRetireInput, MemoryPromoteInput, MemoryReadInput, MemorySearchInput } from "@agent-harness/contracts";
import type { InProcessToolServer } from "../adapter/contract.js";
import type { ToolServerFactory } from "../adapter/seams.js";
import type { MemoryOperations, QueueCaller } from "./memory-operations.js";

const refuse = (message: string): never => { throw new ContractError({ code: "invalid_params", message, data: {} }); };

/**
 * The `memory` tool server of every run whose account has a bank in scope
 * (banks spec, "The memory tools"): each tool parses its input against its
 * published schema and answers what the shared memory operation does, as
 * the run's session, whose queue its drafts join and whose recent use its
 * calls record.
 */
export const createMemoryToolServers = (operations: MemoryOperations): ToolServerFactory => (scope) => {
  const caller: QueueCaller = { accountId: scope.accountId, repositoryIdentity: scope.repositoryIdentity, usedBy: scope.sessionId, queue: scope.sessionId };
  if (operations.inScope(caller).length === 0) return [];
  const server: InProcessToolServer = {
    name: "memory", external: false,
    tools: [
      {
        name: "search", description: "Search memories, folder and topic lines, orientation and entity aliases in banks in scope. Every answer reports n of N, including limited results.",
        inputSchema: z.toJSONSchema(MemorySearchInput),
        call: async (input) => {
          try {
            const parsed = MemorySearchInput.safeParse(input);
            if (!parsed.success) return refuse("The search input does not match its published schema.");
            return { text: await operations.search(caller, parsed.data), isError: false };
          } catch (error) { return answerError(error); }
        },
      },
      {
        name: "read", description: "Follow a bank, folder, topic or memory pointer. Without a pointer, list every bank in scope; reads carry the neighboring folder and count.",
        inputSchema: z.toJSONSchema(MemoryReadInput),
        call: async (input) => {
          try {
            const parsed = MemoryReadInput.safeParse(input);
            if (!parsed.success) return refuse("The read input does not match its published schema.");
            return { text: await operations.read(caller, parsed.data), isError: false };
          } catch (error) { return answerError(error); }
        },
      },
      {
        name: "promote", description: "Land this session's queued drafts and removals in a bank, returning each file's state on main or the review pull request.",
        inputSchema: z.toJSONSchema(MemoryPromoteInput),
        call: async (input) => {
          try {
            const parsed = MemoryPromoteInput.safeParse(input);
            if (!parsed.success) return refuse("The promote input does not match its published schema.");
            const answer = await operations.promote(caller, parsed.data);
            return { text: JSON.stringify(answer), isError: answer.state === "failed" };
          } catch (error) { return answerError(error); }
        },
      },
      {
        name: "draft", description: "Validate and queue one memory for this session. Name a bank when several are writable; use org, project and optional area scope.",
        inputSchema: z.toJSONSchema(MemoryDraftInput),
        call: async (input) => {
          try {
            const parsed = MemoryDraftInput.safeParse(input);
            if (!parsed.success) return refuse("The draft input does not match its published schema.");
            const { bank, change } = await operations.draft(caller, parsed.data);
            return { text: JSON.stringify({ bank, ...change }), isError: false };
          } catch (error) { return answerError(error); }
        },
      },
      {
        name: "retire", description: "Queue removal of a named memory in a bank, with a reason, for the next promote.",
        inputSchema: z.toJSONSchema(MemoryRetireInput),
        call: async (input) => {
          try {
            const parsed = MemoryRetireInput.safeParse(input);
            if (!parsed.success) return refuse("The retirement input does not match its published schema.");
            const { bank, change } = await operations.retire(caller, parsed.data);
            return { text: JSON.stringify({ bank, ...change }), isError: false };
          } catch (error) { return answerError(error); }
        },
      },
    ],
  };
  return [server];
};

const answerError = (error: unknown) => ({
  text: JSON.stringify(error instanceof ContractError ? error.toWire() : { code: "internal", message: "The bank could not be read or changed.", data: {} }), isError: true,
});
