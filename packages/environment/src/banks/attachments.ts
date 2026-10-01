import type { BankEntry } from "@agent-harness/contracts";
import type { ToolGateRule, RuledRun } from "../adapter/seams.js";
import type { RunContainment } from "../adapter/contract.js";
import { resolvePath } from "../permissions/gate.js";
import { isInside } from "../workspace/paths.js";

/** The bank checkouts managed under the environment's data directory. Only this subtree is exempt from its read denylist. */
export const BANKS_DIRECTORY = "banks";

const foldPath = (path: string): string => process.platform === "darwin" || process.platform === "win32" ? path.toLowerCase() : path;
const insideBank = (root: string, path: string): boolean => isInside(foldPath(root), foldPath(path));

/** Enabled checkouts in both scopes, read once as a run starts (banks spec, read-only attach). */
export const bankCheckouts = (entries: readonly BankEntry[], scope: { readonly accountId: string; readonly repositoryIdentity: string | null }): string[] =>
  [...new Set(entries.filter((bank) => bank.enabled
    && (bank.accounts === "all" || bank.accounts.includes(scope.accountId))
    && (bank.repositories === "all" || (scope.repositoryIdentity !== null && bank.repositories.includes(scope.repositoryIdentity))))
    .map((bank) => bank.checkout))];

/** File-tool writes never alter an attached checkout, even with containment off or bypass mode. Shells keep their separate policy. */
export const bankWriteRule = (checkoutsOf: (run: RuledRun) => readonly string[]): ToolGateRule => ({
  decider: "rule",
  check(call, run) {
    if (call.access.kind !== "write") return null;
    const checkouts = checkoutsOf(run);
    if (checkouts.length === 0) return null;
    const roots = checkouts.map((path) => resolvePath(path, run.workspace));
    for (const path of call.access.paths) {
      const resolved = resolvePath(path, run.workspace);
      if (resolved === null || roots.some((root) => root === null || insideBank(root, resolved))) {
        return { decision: "deny", message: `Denied: ${path} may write a read-only bank checkout. Use the memory draft and promote tools to change a bank.` };
      }
    }
    return null;
  },
});

/** A workspace may contain an imported bank; a describe worktree may share git metadata with one. Neither grants writes to the checkout. */
export const bankContainment = (containment: RunContainment, checkouts: readonly string[], workspace: string): RunContainment => {
  if (containment.level === "off" || checkouts.length === 0) return containment;
  const roots = checkouts.map((path) => resolvePath(path, workspace));
  return {
    ...containment,
    writable: containment.writable.filter((path) => {
      const resolved = resolvePath(path, workspace);
      return resolved !== null && roots.every((root) => root !== null && !insideBank(root, resolved));
    }),
    readOnly: [...containment.readOnly, ...checkouts],
  };
};
