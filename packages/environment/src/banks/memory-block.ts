import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** Only the bytes between these markers belong to the bank writer. */
export const BANK_BLOCK_START = "<!-- agent-harness:banks -->";
export const BANK_BLOCK_END = "<!-- /agent-harness:banks -->";

/** Rewrite the whole bank block, retaining every byte the other writers own. */
export const writeBankBlock = async (path: string, text: string): Promise<void> => {
  let held = "";
  try { held = await readFile(path, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const block = `${BANK_BLOCK_START}\n${text}${BANK_BLOCK_END}`;
  const start = held.indexOf(BANK_BLOCK_START);
  const end = start < 0 ? -1 : held.indexOf(BANK_BLOCK_END, start + BANK_BLOCK_START.length);
  // An incomplete block is not safe to replace: the following bytes may be another writer's.
  if (start >= 0 && end < 0) throw new Error("The memory bank block has no closing marker.");
  const next = start < 0 ? `${held}${held === "" || held.endsWith("\n") ? "" : "\n"}${block}\n` : `${held.slice(0, start)}${block}${held.slice(end + BANK_BLOCK_END.length)}`;
  if (next === held) return;
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.banks.tmp`;
  await writeFile(temporary, next, "utf8");
  await rename(temporary, path);
};
