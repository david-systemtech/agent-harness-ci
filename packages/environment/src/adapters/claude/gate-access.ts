import type { JsonObject } from "@agent-harness/contracts";
import type { GatedToolCall, ToolAccess } from "../../adapter/contract.js";

/**
 * Claude's tools as the tool gate reads them (permissions spec, "Modules":
 * the tool gate), each call's input mapped onto what it does, by the
 * pinned SDK's tool inputs (`sdk-tools.d.ts`, checked by #140). The file
 * tools name their path (`file_path`, `notebook_path`; `MultiEdit`, gone
 * from the pinned SDK, is kept for an older CLI), `Glob` its directory and
 * its pattern, `Grep` its directory, `Bash` and `Monitor` their command,
 * `WebFetch` its URL, `WebSearch` its query and allowed domains, and the
 * sandbox's ask for a host (`SandboxNetworkAccess`, which no hook sees) the
 * host, as a fetch; a write tool whose path is missing is a write naming
 * none, which a workspace level denies. Anything else (a tool server's
 * call, a question, a plan, a Monitor with no command) is `other`, whose
 * input the denylist reads.
 */

const text = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);

const WRITE_PATH: Readonly<Record<string, string>> = { Write: "file_path", Edit: "file_path", MultiEdit: "file_path", NotebookEdit: "notebook_path" };
const READ_PATH: Readonly<Record<string, string>> = { Read: "file_path", Grep: "path" };

/** The tool name the CLI's sandbox asks the host about a host under (`can_use_tool`, input `{host}`): a network ask, not a tool call. */
export const SANDBOX_NETWORK_TOOL = "SandboxNetworkAccess";

/**
 * What a Glob reads: its directory, and its pattern as a path it can expand
 * to, in that directory unless the pattern is absolute or `~`; the matcher
 * reads a glob as every path it could expand to, and a relative one against
 * the workspace.
 */
const globPaths = (input: Readonly<Record<string, unknown>>): string[] => {
  const directory = text(input["path"]);
  const pattern = text(input["pattern"]);
  const paths = directory === undefined ? [] : [directory];
  if (pattern === undefined) return paths;
  const rooted = pattern.startsWith("/") || pattern === "~" || pattern.startsWith("~/");
  return [...paths, rooted || directory === undefined ? pattern : `${directory.replace(/\/+$/, "")}/${pattern}`];
};

/** What a Claude tool call does, from its name and input. */
export const claudeToolAccess = (toolName: string, input: Readonly<Record<string, unknown>>): ToolAccess => {
  const writeKey = WRITE_PATH[toolName];
  if (writeKey !== undefined) {
    const path = text(input[writeKey]);
    return { kind: "write", paths: path === undefined ? [] : [path] };
  }
  const readKey = READ_PATH[toolName];
  if (readKey !== undefined) {
    const path = text(input[readKey]);
    return { kind: "read", paths: path === undefined ? [] : [path] };
  }
  if (toolName === "Glob") return { kind: "read", paths: globPaths(input) };
  if (toolName === "Bash") return { kind: "shell", command: text(input["command"]) ?? "" };
  if (toolName === "Monitor") {
    const command = text(input["command"]);
    return command === undefined ? { kind: "other" } : { kind: "shell", command };
  }
  if (toolName === SANDBOX_NETWORK_TOOL) {
    const host = text(input["host"]);
    return { kind: "fetch", urls: host === undefined ? [] : [host] };
  }
  if (toolName === "WebFetch") {
    const url = text(input["url"]);
    return { kind: "fetch", urls: url === undefined ? [] : [url] };
  }
  if (toolName === "WebSearch") {
    const domains = Array.isArray(input["allowed_domains"]) ? input["allowed_domains"].filter((domain): domain is string => typeof domain === "string") : [];
    return { kind: "search", query: text(input["query"]) ?? "", ...(domains.length > 0 && { domains }) };
  }
  return { kind: "other" };
};

/** Longest summary the gate records, in characters: longer is cut, with an ellipsis. */
const SUMMARY_MAX = 200;

/** `text`'s first line, cut to `SUMMARY_MAX`. */
const oneLine = (text: string): string => {
  const line = (text.split("\n")[0] ?? "").trim();
  return line.length > SUMMARY_MAX ? `${line.slice(0, SUMMARY_MAX - 1)}…` : line;
};

/** The one-line summary the gate records: the call's title, else the tool and what it names, cut to a line of at most 200 characters. */
const summaryOf = (toolName: string, access: ToolAccess, title: string | undefined): string => {
  if (title !== undefined && title.trim() !== "") return oneLine(title.trim());
  const named =
    access.kind === "read" || access.kind === "write"
      ? access.paths.join(", ")
      : access.kind === "shell"
        ? access.command
        : access.kind === "fetch"
          ? access.urls.join(", ")
          : access.kind === "search"
            ? access.query
            : "";
  return oneLine(`${toolName} ${named}`);
};

/** The gate's call for a Claude tool call: its id, name, a summary, and what it does. */
export const claudeGatedCall = (toolName: string, input: Readonly<Record<string, unknown>>, toolCallId: string, title?: string): GatedToolCall => {
  const access = claudeToolAccess(toolName, input);
  // The input as the model gave it, as JSON: a denylist prompt records it, and the denylist reads an `other` call's (#132).
  return { toolCallId, tool: toolName, summary: summaryOf(toolName, access, title), access, input: JSON.parse(JSON.stringify(input)) as JsonObject };
};
