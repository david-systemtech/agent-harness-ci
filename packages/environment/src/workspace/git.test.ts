import { describe, expect, it } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { runGit } from "./git.js";

/** git stopped by its caller's signal (#1014): what an environment's close does to a skill source's sync in flight. */

const { tempDir } = useCleanups();

describe("git stopped by its signal", () => {
  it("is stopped as it runs when the signal aborts, answering then, not ok and not timed out", async () => {
    const stopping = new AbortController();
    // An alias whose command runs far past the test: git waits on it until it is stopped.
    const answer = runGit(tempDir(), ["-c", "alias.hang=!sleep 30", "hang"], { maxBytes: 1024, timeoutMs: 10 * 60_000, signal: stopping.signal });
    stopping.abort();
    expect(await answer).toMatchObject({ ok: false, timedOut: false, missing: false, code: null });
  });

  it("never starts once the signal has aborted", async () => {
    expect(await runGit(tempDir(), ["version"], { maxBytes: 1024, signal: AbortSignal.abort() })).toMatchObject({ ok: false, timedOut: false, code: null, stdout: Buffer.alloc(0) });
  });
});
