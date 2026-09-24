import { existsSync, rmSync } from "node:fs";
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
 * their own, none overwriting a file already there, and it is removed.
 */
export const secretsDirectory = (dir: string, legacyFile?: string): SecretStore => {
  const pathOf = (name: string) => join(dir, `${encodeURIComponent(name)}.secret`);
  let migrated: Promise<void> | undefined;
  const ready = (): Promise<void> =>
    (migrated ??= (async () => {
      ensurePrivateDirectory(dir);
      if (legacyFile === undefined) return;
      const text = readTextIfPresent(legacyFile);
      if (text === undefined) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        for (const [name, secret] of Object.entries(parsed)) {
          if (typeof secret === "string" && !existsSync(pathOf(name))) writePrivateFile(pathOf(name), secret);
        }
      }
      rmSync(legacyFile, { force: true });
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
