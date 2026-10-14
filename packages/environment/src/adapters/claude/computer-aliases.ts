import { inProcessToolName, isInProcess, type RunInput } from "../../adapter/contract.js";
import { COMPUTER_TOOL_SERVER } from "../../desktop/tool-server.js";

/** The Claude Code built-in tools an alias must never shadow: a bare name the model emits that is one of these stays the built-in. */
export const CLAUDE_BUILT_IN_TOOL_NAMES: readonly string[] = [
  "Agent", "Bash", "BashOutput", "Edit", "ExitPlanMode", "Glob", "Grep", "KillShell", "ListMcpResources", "LS", "MultiEdit", "NotebookEdit",
  "NotebookRead", "Read", "ReadMcpResource", "Skill", "SlashCommand", "Task", "TaskOutput", "TodoWrite", "WebFetch", "WebSearch", "Write",
];

/**
 * The bare computer toolset member names, each mapped to its tool on the
 * `computer` server (computer spec, "Driver and tool surface"; #2161): a
 * model trained on the toolset that emits `left_click` reaches
 * `mcp__computer__left_click`. Only where the bare member cannot shadow a
 * built-in or another server's tool of the run: a member the browser server
 * also has (screenshot, scroll, type, key) is reached by its full name
 * alone. The alias is name lookup only: the call is still
 * `mcp__computer__<member>` to the gate and the run's mode.
 */
export const computerToolAliases = (run: RunInput): Record<string, string> => {
  const server = run.toolServers.find((candidate) => candidate.name === COMPUTER_TOOL_SERVER);
  if (server === undefined || !isInProcess(server)) return {};
  const taken = new Set(CLAUDE_BUILT_IN_TOOL_NAMES.map((name) => name.toLowerCase()));
  for (const other of run.toolServers) if (other !== server && isInProcess(other)) for (const tool of other.tools) taken.add(tool.name.toLowerCase());
  return Object.fromEntries(server.tools.filter((tool) => !taken.has(tool.name.toLowerCase())).map((tool) => [tool.name, inProcessToolName(COMPUTER_TOOL_SERVER, tool.name)]));
};
