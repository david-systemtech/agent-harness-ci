import type { BankFiles } from "@agent-harness/contracts/bank-validator";
import { runGit } from "../workspace/git.js";

/**
 * A bank's files as the index reads them (banks spec, "Rendering the
 * index"): `BANK.md` and the Markdown under `projects/`, as committed at the
 * checkout's head, never as the working tree holds them. A checkout is the
 * BankService's and nothing is written in it, but a run at containment
 * `off` can still write there until the next sync resets it (banks spec,
 * "Read-only attach"), and such a write must reach no run's index.
 */

/** The most a bank's listing, or its files together, may take: past it the read fails rather than index part of a bank. */
const BANK_READ_BYTES = 64 * 1024 * 1024;

/** Whether the index reads the file at `path`: the manifest, or Markdown under `projects/`. */
const isIndexed = (path: string): boolean => path === "BANK.md" || (path.startsWith("projects/") && path.endsWith(".md"));

/** The files the index reads in the bank checked out at `checkout`, as committed at `ref`; throws when git cannot list or read them. */
export const readBankFiles = async (checkout: string, ref = "HEAD"): Promise<BankFiles> => {
  const listing = await runGit(checkout, ["ls-tree", "-r", "-z", "--full-tree", ref, "--", "BANK.md", "projects"], { maxBytes: BANK_READ_BYTES });
  if (!listing.ok || listing.truncated) throw new Error(`git could not list the bank at ${checkout}: ${listing.stderr.trim() || "it gave no answer"}`);
  // Each entry is `<mode> <type> <object>\t<path>`; a link (120000) or a submodule is not read.
  const entries = listing.stdout
    .toString("utf8")
    .split("\0")
    .flatMap((entry) => {
      const tab = entry.indexOf("\t");
      const [mode, type, object] = entry.slice(0, tab).split(" ");
      const path = entry.slice(tab + 1);
      return tab > 0 && type === "blob" && mode !== "120000" && object !== undefined && isIndexed(path) ? [{ path, object }] : [];
    });
  if (entries.length === 0) return {};
  const blobs = await runGit(checkout, ["cat-file", "--batch"], { maxBytes: BANK_READ_BYTES, input: Buffer.from(`${entries.map((entry) => entry.object).join("\n")}\n`) });
  if (!blobs.ok || blobs.truncated) throw new Error(`git could not read the bank at ${checkout}: ${blobs.stderr.trim() || "it gave no answer"}`);
  // Each object comes back as `<object> blob <size>\n<content>\n`, in the order asked.
  const files: Record<string, string> = {};
  let at = 0;
  for (const { path } of entries) {
    const newline = blobs.stdout.indexOf(0x0a, at);
    const size = Number(blobs.stdout.subarray(at, newline).toString("utf8").split(" ")[2]);
    files[path] = blobs.stdout.subarray(newline + 1, newline + 1 + size).toString("utf8");
    at = newline + 1 + size + 1;
  }
  return files;
};
