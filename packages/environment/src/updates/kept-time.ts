import { readFileSync, renameSync, writeFileSync } from "node:fs";

/**
 * A time the update workstream keeps in a small JSON file of the data
 * directory, so a restart, an update's included, does not read as never:
 * the last check that read the release channel (#346), and the host-side
 * updater's last poll (#348). Each file holds one field, an ISO time.
 */

/** The time `field` of the file at `path` holds, in milliseconds; none when there is no file, or it holds none it can read, which is said on standard error. `what` names the time for people. */
export const readKeptTime = (path: string, field: string, what: string): number | undefined => {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  try {
    const at = Date.parse((JSON.parse(text) as Record<string, unknown>)[field] as string);
    if (Number.isFinite(at)) return at;
  } catch {
    // Said below: a file that is not the record reads as none.
  }
  console.error(`${path} holds no time of ${what}; it reads as none.`);
  return undefined;
};

/** Keeps `at` as `field` of the file at `path`: a temporary file renamed over it, so it is whole or the one before. A failure is said on standard error, and the caller holds the time until it stops. */
export const writeKeptTime = (path: string, field: string, at: number, what: string): void => {
  const temporary = `${path}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify({ [field]: new Date(at).toISOString() })}\n`);
    renameSync(temporary, path);
  } catch (error) {
    console.error(`Keeping the time of ${what} in ${path} failed; the environment holds it until it stops:`, error);
  }
};
