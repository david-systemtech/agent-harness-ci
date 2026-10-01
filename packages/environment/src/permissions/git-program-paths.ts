import { sep } from "node:path";

/** Programs or indirection git reads below a .git directory, including one made during a run (#1094). */
const PROGRAM_PARTS = ["hooks", "config", "config.worktree", "commondir"] as const;

/** Seatbelt's regexes must also cover metadata stored with different case on a case-blind disk. */
const caseBlindGlob = (path: string): string => path.replace(/[a-z]/g, (letter) => `[${letter}${letter.toUpperCase()}]`);

/** Seatbelt can deny these even when they do not exist yet; Linux's pinned runtime skips globs. */
export const GIT_PROGRAM_DENY_WRITE = ["/**/.git", "/**/.git/modules/**", "/**/.git/worktrees/*"].flatMap((directory) =>
  PROGRAM_PARTS.flatMap((part) => [caseBlindGlob(`${directory}/${part}`), caseBlindGlob(`${directory}/${part}/**`)]),
);

/** A .git file itself repoints a checkout; ordinary objects, refs, index and HEAD remain writable. */
export const isGitProgramPath = (path: string, caseInsensitive: boolean): boolean => {
  const parts = (caseInsensitive ? path.toLowerCase() : path).split(sep === "\\" ? /[\\/]/ : "/").filter((part) => part !== "" && part !== ".");
  const program = (part: string | undefined): boolean => PROGRAM_PARTS.some((name) => name === part);
  return parts.some((part, at) => {
    if (part !== ".git") return false;
    const inside = parts.slice(at + 1);
    return inside.length === 0 || program(inside[0]) || (inside[0] === "modules" && inside.slice(1).some(program)) || (inside[0] === "worktrees" && program(inside[2]));
  });
};
