import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { SOURCE_PRODUCT_NAME } from "../src/state-import/source/folders.js";

/** A saved server Connection, in the source's profile list: values are deliberately fake. */
export const sourceConnection = (): Record<string, unknown> => ({ id: "connection-fixture", label: "token-for-tests", providerId: SOURCE_PRODUCT_NAME.toLowerCase(), configDir: "/fixture/connection", publicEnv: {}, secretRef: "token-for-tests" });

/**
 * A source data folder for the state import's tests (ADR 0036; #1165),
 * written the way the source's own writers write it, each file whole: the
 * instruction list as `{version: 1, prompts, dismissedBuiltIns?}`, each
 * prompt with its `id`, `name`, `markdown`, `enabled` and `scope`
 * (`{kind: "all"}` or `{kind: "profiles", profileIds}`), and `builtIn` (with
 * `overridden` once its text was taken over) on a shipped prompt's row; and
 * the desktop's preferences as one object. Every value is a fixture's: no
 * real profile, path or credential.
 */

/** A prompt as the source's instruction list holds one: a custom one, reaching every profile, unless `fields` say otherwise. */
export const sourcePrompt = (id: string, fields: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  name: `Prompt ${id}`,
  markdown: `Text of ${id}.`,
  enabled: true,
  scope: { kind: "all" },
  ...fields,
});

/** The memory-banks prompt the source ships, as its row is first written: left as shipped. */
export const shippedPrompt = (fields: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "builtin:cerebro",
  name: "Use the team memory banks",
  markdown: "",
  enabled: true,
  scope: { kind: "all" },
  builtIn: "builtin:cerebro",
  ...fields,
});

export interface SourceFolderFiles {
  /** The instruction list's prompts; absent, no instruction list is written. */
  readonly prompts?: readonly unknown[];
  readonly dismissedBuiltIns?: readonly string[];
  /** The desktop's preferences; absent, none are written. */
  readonly preferences?: Record<string, unknown>;
}

/** Writes the files `files` names into `folder`, replacing what is there, and answers the folder. */
export const writeSourceFolder = (folder: string, files: SourceFolderFiles): string => {
  if (files.prompts !== undefined) {
    const list = { version: 1, prompts: files.prompts, ...(files.dismissedBuiltIns !== undefined && { dismissedBuiltIns: files.dismissedBuiltIns }) };
    writeFileSync(join(folder, "agent-prompts.json"), JSON.stringify(list), { mode: 0o600 });
  }
  if (files.preferences !== undefined) writeFileSync(join(folder, "prefs.json"), JSON.stringify(files.preferences), { mode: 0o600 });
  return folder;
};
