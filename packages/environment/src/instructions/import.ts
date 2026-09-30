import { realpathSync, readFileSync, statSync } from "node:fs";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { ContractError, InstructionBody, InstructionTitle, MAX_INSTRUCTION_BODY, invalidParams, type Workspace } from "@agent-harness/contracts";
import type { CommandRejection } from "../serve/methods.js";
import { tagsOf, type Reader } from "../sessions/session-tables.js";

/**
 * Reading an instruction an LLM step wrote (ADR 0019; skills spec, "Owned
 * instructions", Minted; #509): a Markdown file inside the scratch
 * workspace of a minted session, one tagged `setup` and the step's id,
 * `instructions`, as the Instructions step mints it (setup spec, "The LLM
 * step and minted sessions"). Its first heading outside a code fence is the
 * title, and the text before and after that heading, a blank line apart, the
 * body. Anything else is `invalid_params`: a session not
 * minted, a path outside the workspace (a symbolic link out of it
 * included) or not a `.md` file, a file with no heading, or one over the
 * bounds. A session not on the environment, or deleted, is `not_found`.
 */

/** The tags a minted session of the Instructions step carries, compared ignoring case. */
export const MINTED_INSTRUCTION_TAGS = ["setup", "instructions"] as const;

/** The most bytes of a file read: every character of a body at its bound, four bytes each, and a heading. */
const MOST_BYTES = MAX_INSTRUCTION_BODY * 4 + 4096;

const refused = (path: string, message: string): ContractError => new ContractError(invalidParams([{ code: "custom", path: [path], message }], message));

/** An ATX heading's text: `# Title`, up to six hashes, a closing run of hashes dropped. */
const HEADING = /^ {0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
/** A code fence line: its run of three or more backticks or tildes, and what follows the run. */
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * The fence a line opens, or null. A backtick fence's info string holds no
 * backtick; the line is then no fence at all.
 */
const opensFence = (line: string): string | null => {
  const match = FENCE.exec(line);
  if (match === null) return null;
  const [, run = "", rest = ""] = match;
  return run.startsWith("`") && rest.includes("`") ? null : run;
};

/** Whether `line` closes the fence `opener` opened: a bare run of its character, at least as long, then only spaces. */
const closesFence = (line: string, opener: string): boolean => {
  const match = FENCE.exec(line);
  if (match === null) return false;
  const [, run = "", rest = ""] = match;
  return run[0] === opener[0] && run.length >= opener.length && rest.trim() === "";
};

/** The file's first heading outside a code fence as the title, and the text before and after it, a blank line apart, as the body; null with no heading. */
export const splitAtFirstHeading = (text: string): { readonly title: string; readonly body: string } | null => {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  let fence: string | null = null;
  for (const [index, line] of lines.entries()) {
    if (fence !== null) {
      if (closesFence(line, fence)) fence = null;
      continue;
    }
    fence = opensFence(line);
    if (fence !== null) continue;
    const heading = HEADING.exec(line)?.[1];
    if (heading === undefined || heading.trim() === "") continue;
    const before = lines.slice(0, index).join("\n").replace(/^(?:[ \t]*\n)+/, "").trimEnd();
    const after = lines.slice(index + 1).join("\n").replace(/^(?:[ \t]*\n)+/, "").trimEnd();
    return { title: heading, body: [before, after].filter((part) => part !== "").join("\n\n") };
  }
  return null;
};

/** Whether `path` lies inside `root`, below it: its first segment is not `..`, so a name such as `..draft.md` is inside. */
const inside = (root: string, path: string): boolean => {
  const rel = relative(root, path);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

export const readMintedFile = (reader: Reader, sessionId: string, path: string): { readonly title: string; readonly body: string } | CommandRejection<"not_found"> => {
  const [row] = reader.all<{ workspace: string }>("SELECT workspace FROM sessions WHERE id = ? AND deleted_at IS NULL", sessionId);
  if (row === undefined) return { code: "not_found", message: `No session ${sessionId} is on this environment.`, data: { kind: "session", sessionId } };
  const workspace = JSON.parse(row.workspace) as Workspace;
  const tags = new Set(tagsOf(reader, sessionId).map((tag) => tag.toLowerCase()));
  if (workspace.kind !== "scratch" || !MINTED_INSTRUCTION_TAGS.every((tag) => tags.has(tag))) {
    throw refused("sessionId", `The session ${sessionId} was not minted by the Instructions step: only a scratch session tagged ${MINTED_INSTRUCTION_TAGS.join(" and ")} is read.`);
  }
  const root = resolve(workspace.path);
  const target = resolve(root, path);
  if (!inside(root, target)) throw refused("path", `${path} is not inside the session's scratch workspace.`);
  if (extname(target).toLowerCase() !== ".md") throw refused("path", `${path} is not a Markdown file: its name does not end in .md.`);
  let real: string;
  try {
    real = realpathSync(target);
  } catch {
    throw refused("path", `No file ${path} is in the session's scratch workspace.`);
  }
  if (!inside(realpathSync(root), real)) throw refused("path", `${path} leads outside the session's scratch workspace.`);
  const stat = statSync(real);
  if (!stat.isFile()) throw refused("path", `${path} is not a file.`);
  if (stat.size > MOST_BYTES) throw refused("path", `${path} is longer than an instruction's body may be, ${MAX_INSTRUCTION_BODY} characters.`);
  const split = splitAtFirstHeading(readFileSync(real, "utf8"));
  if (split === null) throw refused("path", `${path} has no heading to title the instruction by.`);
  if (!InstructionTitle.safeParse(split.title).success) throw refused("path", `The first heading of ${path} is not a title an instruction can take: 1 to 120 characters, with no control characters.`);
  if (!InstructionBody.safeParse(split.body).success) throw refused("path", `${path} is longer than an instruction's body may be, ${MAX_INSTRUCTION_BODY} characters.`);
  return split;
};
