import type { SecretStore } from "@agent-harness/client-runtime";
import { readTextIfPresent, writePrivateFile } from "./files.js";

/**
 * Client session tokens in one file readable by its owner alone (mode
 * 0600): a JSON object from name (the environment id) to token. Changes are
 * read, changed and written back one after another, so two changes in one
 * process never lose each other.
 */
export const secretsFile = (path: string): SecretStore => {
  const read = (): Record<string, string> => {
    const text = readTextIfPresent(path);
    if (text === undefined) return {};
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, string>) : {};
  };
  let changes: Promise<void> = Promise.resolve();
  const change = (edit: (secrets: Record<string, string>) => boolean): Promise<void> => {
    const next = changes.then(() => {
      const secrets = read();
      if (edit(secrets)) writePrivateFile(path, `${JSON.stringify(secrets, null, 2)}\n`);
    });
    changes = next.catch(() => undefined);
    return next;
  };
  return {
    get: async (name) => {
      await changes;
      const secret = read()[name];
      return typeof secret === "string" ? secret : undefined;
    },
    set: (name, secret) =>
      change((secrets) => {
        secrets[name] = secret;
        return true;
      }),
    delete: (name) =>
      change((secrets) => {
        if (!Object.hasOwn(secrets, name)) return false;
        delete secrets[name];
        return true;
      }),
  };
};
