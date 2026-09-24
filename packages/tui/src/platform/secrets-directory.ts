import { existsSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { SecretStore } from "@agent-harness/client-runtime";
import { ensurePrivateDirectory, readTextIfPresent, writePrivateFile } from "./files.js";

/**
 * Client session tokens, one file per name (the environment id) in a
 * directory readable by its owner alone: `<dir>/<name>.secret`, mode 0600,
 * written whole through a rename. A set or delete of one name touches no
 * other's file, so two terminal UIs on one state directory (several run at
 * once) never lose each other's tokens, which one shared file rewritten
 * whole by each could.
 *
 * `legacyFile` is the one `secrets.json` (a JSON object from name to token)
 * earlier builds kept: on first use its tokens are moved into files of
 * their own, none overwriting a file already there, and only then is it
 * removed. One that cannot be read as that object, or that holds an entry
 * that is not a token, is never deleted: its tokens are moved and it is
 * renamed aside to `<legacyFile>.unreadable`, which `report` hears once.
 */
export const secretsDirectory = (dir: string, legacyFile?: string, report?: (error: unknown) => void): SecretStore => {
  const pathOf = (name: string) => join(dir, `${encodeURIComponent(name)}.secret`);
  const split = (legacy: string): void => {
    const text = readTextIfPresent(legacy);
    if (text === undefined) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    // Kept aside rather than deleted, whatever could not be moved out of it: nothing a user had is lost silently.
    const setAside = (why: string): void => {
      const aside = `${legacy}.unreadable`;
      try {
        renameSync(legacy, aside);
      } catch (error) {
        // Another terminal UI on this state directory set it aside first.
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      report?.(new Error(`${legacy} ${why}; it is kept as ${aside}, and those connections need pairing again.`));
    };
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return setAside("is not a JSON object of tokens");
    const skipped: string[] = [];
    for (const [name, secret] of Object.entries(parsed)) {
      if (typeof secret !== "string") skipped.push(name);
      else if (!existsSync(pathOf(name))) writePrivateFile(pathOf(name), secret);
    }
    if (skipped.length > 0) return setAside(`holds entries that are not tokens (${skipped.join(", ")})`);
    rmSync(legacy, { force: true });
  };
  let migrated: Promise<void> | undefined;
  const ready = (): Promise<void> =>
    (migrated ??= (async () => {
      ensurePrivateDirectory(dir);
      if (legacyFile === undefined) return;
      // A move that fails part way is said, and the tokens already moved are kept: it never costs every later token.
      try {
        split(legacyFile);
      } catch (error) {
        report?.(error);
      }
    })());
  return {
    get: async (name) => {
      await ready();
      return readTextIfPresent(pathOf(name));
    },
    set: async (name, secret) => {
      await ready();
      writePrivateFile(pathOf(name), secret);
    },
    delete: async (name) => {
      await ready();
      rmSync(pathOf(name), { force: true });
    },
  };
};
