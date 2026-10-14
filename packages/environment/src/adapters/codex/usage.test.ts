import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { useCleanups } from "../../../test/cleanups.js";
import { lastRateLimits, newestRollout, readCodexUsage } from "./usage.js";

const { tempDir } = useCleanups();

const IDENTITY = { provider: "codex", email: "david@example.com", organisation: null };
const NOW = Date.parse("2026-10-14T12:00:00Z");

const tokenCount = (timestamp: string, primary: number, secondary: number) =>
  JSON.stringify({
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: null,
      rate_limits: {
        primary: { used_percent: primary, window_minutes: 300, resets_at: Date.parse("2026-10-14T15:00:00Z") / 1000 },
        secondary: { used_percent: secondary, window_minutes: 10080, resets_in_seconds: 86_400 },
      },
    },
  });

const rollout = (home: string, day: string, name: string, lines: readonly string[]): void => {
  const directory = join(home, "sessions", ...day.split("-"));
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, name), `${lines.join("\n")}\n`);
};

describe("a Codex home's plan usage, from the CLI's rate-limit readings", () => {
  it("reads the newest rollout's last reading: the five-hour and weekly windows, used and when each resets", async () => {
    const home = join(tempDir(), ".codex");
    rollout(home, "2026-10-12", "rollout-2026-10-12T09-00-00-a.jsonl", [tokenCount("2026-10-12T09:01:00Z", 90, 90)]);
    rollout(home, "2026-10-14", "rollout-2026-10-14T10-00-00-b.jsonl", [
      '{"timestamp":"2026-10-14T10:00:00Z","type":"session_meta","payload":{}}',
      tokenCount("2026-10-14T10:05:00Z", 12, 40),
      tokenCount("2026-10-14T11:30:00Z", 25.5, 41),
      '{"timestamp":"2026-10-14T11:31:00Z","type":"response_item","payload":{"type":"message"}}',
    ]);
    expect(await newestRollout(home)).toContain("rollout-2026-10-14T10-00-00-b.jsonl");
    expect(await readCodexUsage(home, IDENTITY, () => NOW)).toEqual({
      identity: IDENTITY,
      readAt: "2026-10-14T11:30:00.000Z",
      windows: [
        { window: "five_hour", utilisation: 0.255, resetsAt: "2026-10-14T15:00:00.000Z" },
        { window: "seven_day", utilisation: 0.41, resetsAt: "2026-10-15T11:30:00.000Z" },
      ],
    });
  });

  it("is unavailable, saying why, before any session has recorded a reading", async () => {
    const home = join(tempDir(), ".codex");
    expect(await readCodexUsage(home, IDENTITY, () => NOW)).toMatchObject({ windows: [], unavailableReason: expect.stringContaining("after a session's first turn") });
    rollout(home, "2026-10-14", "rollout-x.jsonl", ['{"type":"session_meta"}']);
    expect((await readCodexUsage(home, IDENTITY, () => NOW)).windows).toEqual([]);
  });

  it("skips a line cut short, reading the one before it", () => {
    const cut = '{"timestamp":"x","payload":{"rate_limits":{"primary":';
    expect(lastRateLimits(`${tokenCount("2026-10-14T10:00:00Z", 5, 6)}\n${cut}`)?.at).toBe("2026-10-14T10:00:00Z");
    expect(lastRateLimits("nothing here")).toBeNull();
  });
});
