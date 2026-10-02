import type { ReadinessCheck, ReadinessOverlay, SkillReadiness } from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { manualClock } from "../../test/clock.js";
import { useCleanups } from "../../test/cleanups.js";
import { fakeAdapter } from "../../test/fake-adapter.js";
import type { KeyManagerRegistry, ReferenceResolution } from "../key-managers/registry.js";
import type { GitAnswer } from "../workspace/git.js";
import type { PlacedSet } from "./generations.js";
import { READINESS_CALL_BUDGET_MS, READINESS_CHECK_BUDGET_MS, createSkillReadiness, type ReadinessGit } from "./readiness.js";

/**
 * Readiness's budgets under a held clock (skills spec, "Readiness"): each
 * check gets five seconds and the call ten, from when it is asked; a check
 * still running then fails as could not be checked in time, the others
 * answering as they do. The service is driven at its own seam, its scope
 * and set given, its git one that answers only when the test says.
 */

const { tempDir } = useCleanups();

const REPOSITORY = "https://github.com/example/skills";

/** An overlay declaring `checks` for the member at `slow`. */
const declaring = (checks: ReadinessCheck[]): ReadinessOverlay => [{ repository: REPOSITORY, path: "slow", removedUpstream: false, declaration: { version: 1, checks } }];

/** An overlay declaring, for the member at `slow`, a git check and a tool check. */
const overlay = declaring([{ kind: "git", condition: "repository", why: "It works in a repository." }, { kind: "tool", command: "gh" }]);

/** The one member, `slow`, its origin the overlay's entry. */
const set: PlacedSet = {
  members: [
    {
      name: "slow",
      description: "Slow to check.",
      kind: "command",
      target: "/nonexistent/agent-harness-slow.md",
      origin: { kind: "repository", repository: REPOSITORY, path: "slow" },
      commit: null,
      invocation: "model+slash",
      userInvocable: true,
      argumentHint: null,
      native: false,
      alwaysOn: false,
    },
  ],
  hiddenNativeNames: [],
};

/** A git that answers each call only when `answer` is called, counting the calls. */
const heldGit = () => {
  const waiting: ((answer: GitAnswer) => void)[] = [];
  const git: ReadinessGit = () => new Promise((resolve) => waiting.push(resolve));
  return {
    git,
    asked: () => waiting.length,
    answerAll: (stdout: string) => {
      for (const resolve of waiting.splice(0)) resolve({ ok: true, stdout: Buffer.from(stdout), truncated: false, timedOut: false, missing: false, code: 0, stderr: "" });
    },
  };
};

/** A key-manager registry whose resolves answer only when the test says, counting the values answered and not yet let go. */
const heldKeyManagers = () => {
  const waiting: ((answer: ReferenceResolution) => void)[] = [];
  let outstanding = 0;
  const registry: KeyManagerRegistry = { resolve: () => new Promise((resolve) => waiting.push(resolve)) };
  return {
    registry,
    asked: () => waiting.length,
    outstanding: () => outstanding,
    resolveAll: (value: string) => {
      for (const resolve of waiting.splice(0)) {
        outstanding += 1;
        resolve({ outcome: "resolved", value, release: () => void (outstanding -= 1) });
      }
    },
  };
};

const start = (options: { readonly place?: () => Promise<PlacedSet>; readonly overlay?: ReadinessOverlay } = {}) => {
  const clock = manualClock();
  const held = heldGit();
  const keyManagers = heldKeyManagers();
  const workspace = tempDir();
  const readiness = createSkillReadiness({
    scopeOf: async () => ({ sessionId: null, accountId: "claude-max", workspace: { kind: "directory", path: workspace }, repositoryIdentity: null, trust: { key: null, decision: "undecided" } }),
    account: () => ({ descriptor: fakeAdapter().descriptor }),
    place: options.place ?? (async () => set),
    hostEnv: { PATH: "/nonexistent/agent-harness-test-path" },
    clock,
    overlay: options.overlay ?? overlay,
    git: held.git,
    keyManagers: keyManagers.registry,
  });
  const read = (): Promise<SkillReadiness[]> => readiness.read({ accountId: "claude-max", workspace: { kind: "directory", path: workspace } }).then((answer) => answer.skills);
  return { clock, held, keyManagers, read };
};

/** Whether `promise` has settled, without waiting for it. */
const settled = async (promise: Promise<unknown>): Promise<boolean> => {
  const marker = Symbol("pending");
  return (await Promise.race([promise.then(() => true), new Promise((resolve) => setImmediate(() => resolve(marker)))])) !== marker;
};

const TIMED_OUT = ["timed-out", "It could not be checked in time."];

describe("readiness's budgets", () => {
  it("fails a check still running after five seconds as could not be checked in time, the others answering as they do", async () => {
    const { clock, held, read } = start();
    const answer = read();
    await vi.waitFor(() => expect(held.asked()).toBe(1));

    clock.advance(READINESS_CHECK_BUDGET_MS - 1);
    expect(await settled(answer)).toBe(false);
    clock.advance(1);
    const [slow] = await answer;
    expect(slow).toMatchObject({ name: "slow", state: "setup-needed", declaredBy: "overlay", why: "It works in a repository." });
    expect(slow?.state !== "ready" && slow?.failing.map((failure) => [failure.outcome, failure.message])).toEqual([
      TIMED_OUT,
      ["failed", "gh is not on the PATH a run on this environment gets."],
    ]);
    expect(clock.pending()).toBe(0);
  });

  it("fails a secret check whose resolve stalls as could not be checked in time, and lets go of a value answered after", async () => {
    const reference = { provider: "doppler", connectionId: "c0ffee00-0000-4000-8000-000000000001", name: "TRACKER_TOKEN" } as const;
    const { clock, keyManagers, read } = start({ overlay: declaring([{ kind: "secret", reference }]) });
    const answer = read();
    await vi.waitFor(() => expect(keyManagers.asked()).toBe(1));

    clock.advance(READINESS_CHECK_BUDGET_MS);
    const [slow] = await answer;
    expect(slow?.state !== "ready" && slow?.failing.map((failure) => [failure.outcome, failure.message])).toEqual([TIMED_OUT]);
    keyManagers.resolveAll("value-for-tests");
    await vi.waitFor(() => expect(keyManagers.outstanding()).toBe(0));
  });

  it("bounds a check that starts late by what is left of the call's ten seconds", async () => {
    let release: ((value: PlacedSet) => void) | undefined;
    const { clock, held, read } = start({ place: () => new Promise((resolve) => (release = resolve)) });
    const answer = read();
    await vi.waitFor(() => expect(release).toBeDefined());
    clock.advance(7_000);
    release?.(set);
    await vi.waitFor(() => expect(held.asked()).toBe(1));

    clock.advance(READINESS_CALL_BUDGET_MS - 7_000 - 1);
    expect(await settled(answer)).toBe(false);
    clock.advance(1);
    const [slow] = await answer;
    expect(slow?.state !== "ready" && slow?.failing[0]).toMatchObject({ outcome: "timed-out" });
  });

  it("keeps no answer with a check that ran out, so the next read checks again", async () => {
    const { clock, held, read } = start();
    const first = read();
    await vi.waitFor(() => expect(held.asked()).toBe(1));
    clock.advance(READINESS_CHECK_BUDGET_MS);
    await first;

    const second = read();
    await vi.waitFor(() => expect(held.asked()).toBe(2));
    held.answerAll("/repository\n");
    const [slow] = await second;
    expect(slow?.state !== "ready" && slow?.failing.map((failure) => failure.outcome)).toEqual(["failed"]);
  });
});
