import { open, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { AccountIdentity } from "@agent-harness/contracts";
import type { UsageReading, UsageWindow } from "../../adapter/contract.js";

/**
 * A Codex login's plan usage (#2169), from the rate-limit reading the CLI
 * records: each turn's `token_count` event in a session rollout
 * (`<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-*.jsonl`) carries
 * `rate_limits: { primary, secondary }`, each `{ used_percent,
 * window_minutes, resets_at (Unix seconds) | resets_in_seconds }`: on a
 * ChatGPT plan the five-hour window and the weekly one. The newest
 * rollout's last reading is the account's; it is as fresh as the last
 * turn any Codex session on the home took, which `readAt` says.
 */

/** How much of the newest rollout's tail is read for its last reading. */
const TAIL_BYTES = 256 * 1024;

/** The window names the usage labels know, by length in minutes; another length is named by its minutes. */
const windowName = (minutes: unknown, fallback: string): string => {
  if (minutes === 300) return "five_hour";
  if (minutes === 10080) return "seven_day";
  return typeof minutes === "number" && Number.isFinite(minutes) ? `${Math.round(minutes)}_minutes` : fallback;
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The entries of `directory` sorted newest name first; none when it cannot be listed. */
const newestFirst = async (directory: string): Promise<string[]> => {
  try {
    return (await readdir(directory)).sort().reverse();
  } catch {
    return [];
  }
};

/** The newest rollout file under `sessions`, walking year, month and day folders newest first. */
export const newestRollout = async (home: string): Promise<string | null> => {
  const sessions = join(home, "sessions");
  for (const year of await newestFirst(sessions)) {
    for (const month of await newestFirst(join(sessions, year))) {
      for (const day of await newestFirst(join(sessions, year, month))) {
        const rollout = (await newestFirst(join(sessions, year, month, day))).find((name) => name.startsWith("rollout-") && name.endsWith(".jsonl"));
        if (rollout !== undefined) return join(sessions, year, month, day, rollout);
      }
    }
  }
  return null;
};

const tail = async (path: string): Promise<string> => {
  const file = await open(path, "r");
  try {
    const { size } = await file.stat();
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    await file.read(buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } finally {
    await file.close();
  }
};

/** The last rate-limit reading in a rollout's lines, with when it was recorded; null when it holds none. */
export const lastRateLimits = (lines: string): { readonly limits: Record<string, unknown>; readonly at: string | null } | null => {
  const all = lines.split("\n");
  for (let index = all.length - 1; index >= 0; index -= 1) {
    const line = all[index]?.trim() ?? "";
    if (!line.includes("rate_limits")) continue;
    try {
      const entry: unknown = JSON.parse(line);
      if (!isRecord(entry)) continue;
      const payload = isRecord(entry["payload"]) ? entry["payload"] : entry;
      const limits = payload["rate_limits"];
      if (isRecord(limits)) return { limits, at: typeof entry["timestamp"] === "string" ? entry["timestamp"] : null };
    } catch {
      // A line cut by the tail's start, or one being written: the one before it is read.
    }
  }
  return null;
};

const windowOf = (fallback: string, entry: unknown, recordedAt: number): UsageWindow | null => {
  if (!isRecord(entry)) return null;
  const used = entry["used_percent"];
  const resetsAt =
    typeof entry["resets_at"] === "number"
      ? new Date(entry["resets_at"] * 1000).toISOString()
      : typeof entry["resets_in_seconds"] === "number"
        ? new Date(recordedAt + entry["resets_in_seconds"] * 1000).toISOString()
        : null;
  return { window: windowName(entry["window_minutes"], fallback), utilisation: typeof used === "number" ? used / 100 : null, resetsAt };
};

/** The account's plan usage from its home's newest rollout; unavailable, with why, when none has a reading yet. */
export const readCodexUsage = async (home: string, identity: AccountIdentity, now: () => number = Date.now): Promise<UsageReading> => {
  const readAt = new Date(now()).toISOString();
  const rollout = await newestRollout(home);
  const found = rollout === null ? null : lastRateLimits(await tail(rollout));
  if (found === null) return { identity, windows: [], readAt, unavailableReason: "Codex reports plan usage after a session's first turn; this account has none yet." };
  const recordedAt = found.at !== null && !Number.isNaN(Date.parse(found.at)) ? Date.parse(found.at) : now();
  const windows = [windowOf("primary", found.limits["primary"], recordedAt), windowOf("secondary", found.limits["secondary"], recordedAt)].filter(
    (window): window is UsageWindow => window !== null,
  );
  return windows.length === 0
    ? { identity, windows, readAt, unavailableReason: "The Codex rate-limit reading held no windows." }
    : { identity, windows, readAt: new Date(recordedAt).toISOString() };
};
