import { createHash } from "node:crypto";

/**
 * The names the environment gives the directories it keeps per repository:
 * a repository's auto-memory directory (#121) and its directory under the
 * worktrees root (#326). Each is a slug for a person reading the directory
 * and, where two keys must never share a name, a short hash of the key.
 */

/** `text` lower-cased, each run of anything but letters and digits one dash, its last 48 characters, no dash at either end; `fallback` when nothing is left. */
export const slug = (text: string, fallback: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(-48)
    .replace(/^-+/, "") || fallback;

/** The slug of `label`, a dash, and the first 12 hex digits of `key`'s SHA-256: named for a person, and never shared by two keys. */
export const hashedName = (label: string, key: string, fallback: string): string =>
  `${slug(label, fallback)}-${createHash("sha256").update(key).digest("hex").slice(0, 12)}`;
