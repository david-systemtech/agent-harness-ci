import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { WAIT_MS } from "../../../test/wire-client.js";
import { useCleanups } from "../../../test/cleanups.js";
import { manualClock } from "../../../test/clock.js";
import { openEventLog } from "../../event-log/event-log.js";
import { createProviderTranscriptStore } from "../../provider-transcripts/store.js";
import { importSessionToStore } from "@anthropic-ai/claude-agent-sdk";
import { seedStoreFromDirectory } from "./imported-history.js";
import { createConfigDirQueue } from "./config-dir-queue.js";
import { composeRunEnvironment } from "./credentials.js";

/**
 * The pinned SDK's resume from the environment's store, on a real `query()`
 * (verify-first item 1 as far as it runs without an account): the Claude
 * executable is a Node script that records the environment, argv and config
 * directory it was spawned with and exits, so nothing reaches the network.
 * What it shows: a session stored under the harness session's id is loaded
 * by the project directory's name beside `CLAUDE_CONFIG_DIR`, whatever the
 * working directory; it is written into a temporary config directory seeded
 * with the credentials of the account the run names (the refresh token
 * left out), subagent transcripts and all; the CLI is spawned there with
 * `--resume`; and the SDK deletes that directory once the CLI has exited.
 * And (#229) that the environment the adapter composes reaches the resumed
 * CLI with its credential store at the account's own directory, where the
 * refresh token the temporary copy lacks still is. Whether the real CLI
 * then resumes the transcript whole, bills that account and refreshes from
 * that store needs a signed-in account (the spec's Further Notes, #217).
 */

const { onCleanup, tempDir } = useCleanups();

const HARNESS = "6f1d2a4e-8c3b-4f5a-9d7e-1a2b3c4d5e6f";
const PROVIDER = "5d1e9c3a-7b2f-4e8d-9a6c-3f0b1e2d4c5a";

interface Spawned {
  readonly argv: string[];
  readonly cwd: string;
  readonly configDir: string;
  readonly files: string[];
  readonly credentials: unknown;
  /** The CLI's credential store, when the environment names one, and the login it holds. */
  readonly secureStorage: string | null;
  readonly storedCredentials: unknown;
}

const RECORDER = `
import { writeFileSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
const dir = process.env.CLAUDE_CONFIG_DIR;
const walk = (d, p = "") => existsSync(d) ? readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(join(d, e.name), join(p, e.name)) : [join(p, e.name)]) : [];
const read = (path) => existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
const secureStorage = process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR ?? null;
writeFileSync(process.env.RECORD_TO, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), configDir: dir, files: walk(dir).sort(), credentials: read(join(dir, ".credentials.json")), secureStorage, storedCredentials: secureStorage === null ? null : read(join(secureStorage, ".credentials.json")) }));
process.exit(0);
`;

const resumeUnder = async (options: { readonly projectDirName: string | null; readonly composed?: boolean; readonly secondary?: boolean }): Promise<{ spawned: Spawned; accountB: string }> => {
  const root = tempDir("claude-store-resume-");
  const accountB = join(root, "account-b");
  mkdirSync(accountB);
  writeFileSync(join(accountB, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "b-access", refreshToken: "b-refresh", expiresAt: 1 } }));
  const recorder = join(root, "claude.mjs");
  writeFileSync(recorder, RECORDER);
  const log = openEventLog({ path: ":memory:" });
  onCleanup(() => log.close());
  const store = createProviderTranscriptStore({ log, clock: manualClock() });
  if (options.secondary) {
    const secondary = join(root, "secondary");
    const project = join(secondary, "projects", "fixture");
    mkdirSync(join(project, PROVIDER, "subagents"), { recursive: true });
    writeFileSync(join(secondary, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "secondary-for-tests", refreshToken: "secondary-refresh-for-tests" } }));
    const parent = { type: "user", uuid: "u1", parentUuid: null, sessionId: PROVIDER, cwd: root, message: { role: "user", content: "Hi from secondary" } };
    writeFileSync(join(project, `${PROVIDER}.jsonl`), JSON.stringify(parent) + "\n");
    writeFileSync(join(project, PROVIDER, "subagents", "agent-a1.jsonl"), JSON.stringify({ ...parent, uuid: "s1", isSidechain: true, agentId: "a1" }) + "\n");
    await seedStoreFromDirectory({ directory: secondary, queue: createConfigDirQueue(process.env), harnessSessionId: HARNESS, providerSessionId: PROVIDER, store, required: true, importSessionToStore });
    expect((await store.load({ projectKey: HARNESS, sessionId: PROVIDER }))?.[0]?.message).toEqual({ role: "user", content: "Hi from secondary" });
    expect(readFileSync(join(secondary, ".credentials.json"), "utf8")).toContain("secondary-refresh-for-tests");
  } else {
    // As a run under account A left it: the mirror keyed it by the harness session.
    await store.append({ projectKey: HARNESS, sessionId: PROVIDER }, [{ type: "user", uuid: "u1", parentUuid: null, sessionId: PROVIDER, message: { role: "user", content: "Hi" } }]);
    await store.append({ projectKey: HARNESS, sessionId: PROVIDER, subpath: "subagents/agent-a1" }, [{ type: "user", uuid: "s1", sessionId: PROVIDER }]);
  }
  const record = join(root, "spawned.json");
  // Another working directory than the first run's: the key must not depend on it.
  const cwd = join(root, "elsewhere");
  mkdirSync(cwd);
  const made = query({
    prompt: "Go on",
    options: {
      cwd,
      sessionStore: store,
      resume: PROVIDER,
      pathToClaudeCodeExecutable: recorder,
      executable: "node",
      env:
        options.composed === true
          ? // As the adapter composes a run's environment (`options.ts`), with the recorder's own variable beside it.
            composeRunEnvironment({ PATH: process.env["PATH"] ?? "", RECORD_TO: record }, accountB, { CLAUDE_CODE_PROJECT_DIR_NAME: options.projectDirName ?? "" })
          : {
              PATH: process.env["PATH"] ?? "",
              CLAUDE_CONFIG_DIR: accountB,
              RECORD_TO: record,
              ...(options.projectDirName !== null && { CLAUDE_CODE_PROJECT_DIR_NAME: options.projectDirName }),
            },
    },
  });
  let failure: unknown;
  try {
    for await (const message of made) void message;
  } catch (error) {
    // The recorder answers nothing, so the query ends in error once it exits; what it recorded is the point.
    failure = error;
  }
  // A recorder that never ran leaves no record: the query's own error says why.
  await expect.poll(() => existsSync(record), { timeout: 10_000, message: `The recorder wrote no record; the query ended with: ${String(failure)}` }).toBe(true);
  return { spawned: JSON.parse(readFileSync(record, "utf8")) as Spawned, accountB };
};

describe("the pinned SDK resuming from the store", () => {
  it("loads the session by the project directory's name from another working directory, seeds a temporary directory with the named account's credentials, and deletes it after", async () => {
    const { spawned, accountB } = await resumeUnder({ projectDirName: HARNESS });
    expect(spawned.argv).toContain(`--resume=${PROVIDER}`);
    expect(spawned.configDir).not.toBe(accountB);
    expect(spawned.files).toEqual([".credentials.json", `projects/${HARNESS}/${PROVIDER}.jsonl`, `projects/${HARNESS}/${PROVIDER}/subagents/agent-a1.jsonl`]);
    // The account the run names is the one billed; the SDK withholds the refresh token from the temporary copy.
    expect(spawned.credentials).toEqual({ claudeAiOauth: { accessToken: "b-access", expiresAt: 1 } });
    await expect.poll(() => existsSync(spawned.configDir), { timeout: 10_000 }).toBe(false);
  });

  it("hands the resumed CLI the account's own directory as its credential store, where the refresh token the copy lacks still is (#229)", async () => {
    const { spawned, accountB } = await resumeUnder({ projectDirName: HARNESS, composed: true });
    expect(spawned.argv).toContain(`--resume=${PROVIDER}`);
    expect(spawned.configDir).not.toBe(accountB);
    expect(spawned.credentials).toEqual({ claudeAiOauth: { accessToken: "b-access", expiresAt: 1 } });
    // Passed through as the run sets it, not replaced: the pinned SDK sets the variable itself on Windows only, and only when the run has none.
    expect(spawned.secureStorage).toBe(accountB);
    expect(spawned.storedCredentials).toEqual({ claudeAiOauth: { accessToken: "b-access", refreshToken: "b-refresh", expiresAt: 1 } });
  });

  it("resumes hydrated secondary parent and subagent files using only the winner's temporary access token and original refresh store", async () => {
    const { spawned, accountB } = await resumeUnder({ projectDirName: HARNESS, composed: true, secondary: true });
    expect(spawned.argv).toContain(`--resume=${PROVIDER}`);
    expect(spawned.files).toEqual([".credentials.json", `projects/${HARNESS}/${PROVIDER}.jsonl`, `projects/${HARNESS}/${PROVIDER}/subagents/agent-a1.jsonl`]);
    expect(spawned.credentials).toEqual({ claudeAiOauth: { accessToken: "b-access", expiresAt: 1 } });
    expect(spawned.secureStorage).toBe(accountB);
    expect(spawned.storedCredentials).toEqual({ claudeAiOauth: { accessToken: "b-access", refreshToken: "b-refresh", expiresAt: 1 } });
    await expect.poll(() => existsSync(spawned.configDir), { timeout: WAIT_MS }).toBe(false);
  });

  it("finds nothing without the project directory's name, and runs in the account's own directory", async () => {
    const { spawned, accountB } = await resumeUnder({ projectDirName: null });
    expect(spawned.configDir).toBe(accountB);
  });
});
