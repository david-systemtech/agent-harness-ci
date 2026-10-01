import { oneLine } from "@agent-harness/client-runtime";
import { trustOfferEmpty, type ResultOf } from "@agent-harness/contracts";

/** The session's advisory trust question; a decision or an empty offer leaves no question. */
export const trustQuestion = (trust: ResultOf<"trust.get"> | null | undefined): string | undefined => {
  if (trust?.key == null || trust.decision !== "undecided" || trust.offer === null || trustOfferEmpty(trust.offer)) return undefined;
  const offer = trust.offer;
  const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
  const counts = [
    count(offer.instructionFiles.length, "instruction"),
    count(offer.skillRoots.reduce((sum, root) => sum + root.members, 0), "skill"),
    count(offer.commands, "command"),
    count(offer.hooks.reduce((sum, event) => sum + event.hooks, 0), "hook"),
    count(offer.permissionRules.allow + offer.permissionRules.ask + offer.permissionRules.deny, "permission rule"),
    count(offer.subagents, "subagent"),
    `${count(offer.mcpServers.length, "MCP server")} not loaded`,
  ];
  return `Trust ${oneLine(trust.key)}? ${counts.join(", ")}. /trust or /trust decline`;
};
