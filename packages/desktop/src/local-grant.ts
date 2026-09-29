import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { GrantReader } from "@agent-harness/client-runtime";
import { BOOTSTRAP_GRANT_FILE, BootstrapGrant } from "@agent-harness/contracts";

/**
 * The shell's `localGrant` (docs/specs/gui.md, "The desktop shell"): the
 * bootstrap grant this machine's environment writes in its data directory on
 * every start, read for the runtime, which exchanges its secret over
 * loopback. None while no environment runs, and none for a file no
 * environment wrote; one that cannot be read at all (a permission, a
 * directory in its place) is none too, which `report` hears once until a
 * read succeeds again. It never rejects: the runtime takes an unreadable
 * grant as none, and the local environment as not running.
 */
export const grantFile = (environmentDir: string, report: (error: unknown) => void): GrantReader => {
  const path = join(environmentDir, BOOTSTRAP_GRANT_FILE);
  let reported = false;
  return {
    async read() {
      let text: string;
      try {
        text = await readFile(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          reported = false;
          return undefined;
        }
        if (!reported) report(new Error(`The grant file ${path} cannot be read: ${error instanceof Error ? error.message : String(error)}`));
        reported = true;
        return undefined;
      }
      reported = false;
      try {
        const grant = BootstrapGrant.safeParse(JSON.parse(text));
        return grant.success ? grant.data : undefined;
      } catch {
        return undefined;
      }
    },
  };
};
