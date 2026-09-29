import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { userInfo } from "node:os";
import { registry, type RunInstructionsComposedPayload } from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { bubblewrapProbe } from "../../test/containment.js";
import { startFakeForge, type FakeForge } from "../../test/fake-forge.js";
import { DAVID, TOKEN, added, verify } from "../../test/forge.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { create, workspace } from "../../test/sessions.js";
import { WAIT_MS, type WireClient } from "../../test/wire-client.js";
import type { InstructionScope } from "../adapter/seams.js";
import type { OrientationSection } from "./orientation.js";

/**
 * The OrientationRenderer (key-managers spec, "The orientation block"; ADR
 * 0011; #380) through the primary seam: the in-process environment with the
 * scripted fake adapter reporting the instructions each run was handed and
 * each process was spawned with, test section providers that throw, stall
 * and overflow, the fake forge, and the manual clock, which holds the
 * renderer's one-second budget. What is asserted is the text a run is
 * handed, its manifest, and which process serves it.
 */

const { onCleanup, tempDir } = useCleanups();

const start = async (options: TestEnvironmentOptions = {}): Promise<TestEnvironment> => {
  const t = await startTestEnvironment(options);
  onCleanup(() => t.close());
  return t;
};

const ended = (t: TestEnvironment, sessionId: string) => t.env.log.readStream({ kind: "session", id: sessionId }).filter((event) => event.type === "run.ended");

/** Starts a run on the session; resolves once it is accepted, with what waits for its end and answers the instructions it was handed. */
const startRun = async (t: TestEnvironment, client: WireClient, sessionId: string, text = "Fix the receipts"): Promise<() => Promise<string>> => {
  const before = ended(t, sessionId).length;
  const answer = registry["runs.start"].response.parse(await client.request("runs.start", { commandId: randomUUID(), sessionId, text }));
  if (answer.result === undefined) throw new Error(`runs.start was refused: ${JSON.stringify(answer.receipt)}`);
  return async () => {
    // Within the frame wait, not vi.waitFor's preset second, which a loaded runner outlasts (#597).
    await vi.waitFor(() => expect(ended(t, sessionId)).toHaveLength(before + 1), { timeout: WAIT_MS });
    return t.adapter.lastRun().input.instructions;
  };
};

/** Starts a run on the session, waits for its end, and answers the instructions it was handed. */
const runTo = async (t: TestEnvironment, client: WireClient, sessionId: string, text?: string): Promise<string> => (await startRun(t, client, sessionId, text))();

/** The manifest of the session's latest composition. */
const manifestOf = (t: TestEnvironment, sessionId: string) =>
  (t.env.log.readStream({ kind: "session", id: sessionId }).findLast((event) => event.type === "run.instructions.composed")?.payload as RunInstructionsComposedPayload | undefined)?.manifest;

/** The block's section headings, in the order the text holds them. */
const headings = (text: string): string[] => text.match(/^## .+$/gm) ?? [];

/** The items of the list under `heading`, up to the paragraph's end. */
const listOf = (text: string, heading: string): string[] => {
  const start = text.indexOf(`\n${heading}\n`);
  if (start === -1) throw new Error(`No list is headed ${heading}.`);
  const paragraph = text.slice(start + heading.length + 2).split("\n\n")[0] ?? "";
  return paragraph.split("\n").map((line) => line.replace(/^- /, ""));
};

/** The items of the section titled `title`, whose one paragraph is a list with no heading. */
const sectionOf = (text: string, title: string): string[] => {
  const start = text.indexOf(`## ${title}\n\n`);
  if (start === -1) throw new Error(`No section is titled ${title}.`);
  const paragraph = text.slice(start + title.length + 5).split("\n\n")[0] ?? "";
  return paragraph.split("\n").map((line) => line.replace(/^- /, ""));
};

/** A section a test registers, answering `lines` at once. */
const section = (name: OrientationSection["name"], title: string, ...lines: string[]): OrientationSection => ({ name, title, render: () => lines });

const fakeForge = async (): Promise<FakeForge> => {
  const forge = await startFakeForge();
  onCleanup(() => forge.close());
  return forge;
};

/** The command git would name as its helper: never run here. */
const HELPER = ["/opt/agent-harness/bin/agent-harness"];

describe("the OrientationRenderer", () => {
  it("renders the sections registered with it in the order environment, key managers, forges, banks, other environments, whatever order they registered in", async () => {
    const forge = await fakeForge();
    const t = await start({
      forgeFetch: forge.fetch,
      harnessCommand: HELPER,
      orientationSections: [
        section("other-environments", "Other environments", "laptop at https://laptop.example"),
        section("banks", "Banks", "cortex: a memory bank"),
        section("key-managers", "Key managers", "No key manager is connected here."),
      ],
    });
    const client = await t.client();
    forge.user(TOKEN, DAVID);
    await added(client, { url: forge.origin, kind: "forgejo", slug: "home" });
    const session = await create(client);

    const text = await runTo(t, client, session.id);

    expect(text.startsWith("# Orientation\n\n## This environment\n\n")).toBe(true);
    expect(headings(text)).toEqual(["## This environment", "## Key managers", "## Forges", "## Banks", "## Other environments"]);
  });

  it("is byte-identical across runs whose state has not changed, twenty minutes and a verification that changed nothing between them, so the session's process is reused", async () => {
    const forge = await fakeForge();
    const t = await start({ forgeFetch: forge.fetch, harnessCommand: HELPER, orientationSections: [section("banks", "Banks", "cortex: a memory bank")] });
    const client = await t.client();
    forge.user(TOKEN, DAVID);
    await added(client, { url: forge.origin, kind: "forgejo", slug: "home" });
    const session = await create(client);
    const first = await runTo(t, client, session.id);

    // Within the process's idle time, so only a changed text would let it go.
    t.clock.advance(20 * 60 * 1000);
    await verify(client);
    const second = await runTo(t, client, session.id, "Twenty minutes later");

    expect(second).toBe(first);
    // No line reads the clock: the only time is the forge's status's last change, 00:00.
    expect(second.match(/\d{2}:\d{2}/g)).toEqual(["00:00"]);
    expect(t.adapter.processesOf(session.id)).toHaveLength(1);
  });

  it("leaves out a section no provider is registered for", async () => {
    const t = await start({ orientationSections: [section("banks", "Banks", "cortex: a memory bank")] });
    const client = await t.client();
    const session = await create(client);

    const text = await runTo(t, client, session.id);

    expect(headings(text)).toEqual(["## This environment", "## Banks"]);
    expect(text.endsWith("## Banks\n\ncortex: a memory bank")).toBe(true);
  });

  it("renders a section whose provider throws as could not be read, names it in the seam's answer, and renders the others", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    onCleanup(() => errors.mockRestore());
    const failing: OrientationSection = {
      name: "key-managers",
      title: "Key managers",
      render: () => {
        throw new Error("The key-manager registry could not be read.");
      },
    };
    const rejecting: OrientationSection = { name: "other-environments", title: "Other environments", render: () => Promise.reject(new Error("No report could be read.")) };
    const t = await start({ orientationSections: [failing, section("banks", "Banks", "cortex: a memory bank"), rejecting] });
    const client = await t.client();
    const session = await create(client);

    const text = await runTo(t, client, session.id);

    expect(headings(text)).toEqual(["## This environment", "## Key managers", "## Banks", "## Other environments"]);
    expect(text).toContain("## Key managers\n\nCould not be read.\n\n## Banks\n\ncortex: a memory bank\n\n## Other environments\n\nCould not be read.");
    expect(manifestOf(t, session.id)).toMatchObject({ unreadRegistries: ["key-managers", "other-environments"] });
    expect(ended(t, session.id).at(-1)?.payload).not.toMatchObject({ reason: "error" });
    expect(errors.mock.calls.map((call) => String(call[0]))).toEqual(
      expect.arrayContaining([
        expect.stringContaining("The orientation block's key-managers section failed; the block shows it as could not be read"),
        expect.stringContaining("The orientation block's other-environments section failed; the block shows it as could not be read"),
      ]),
    );
  });

  it("renders a section whose provider takes a second on the environment's clock as could not be read, names it, and renders the others", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    onCleanup(() => errors.mockRestore());
    let asked = 0;
    const stalled: OrientationSection = {
      name: "banks",
      title: "Banks",
      render: () => {
        asked += 1;
        return new Promise<never>(() => undefined);
      },
    };
    const t = await start({ orientationSections: [stalled, section("key-managers", "Key managers", "No key manager is connected here.")] });
    const client = await t.client();
    const session = await create(client);
    const untilEnded = await startRun(t, client, session.id);
    await vi.waitFor(() => expect(asked).toBe(1), { timeout: WAIT_MS });

    t.clock.advance(1000);
    const text = await untilEnded();

    expect(text).toContain("## Key managers\n\nNo key manager is connected here.\n\n## Banks\n\nCould not be read.");
    expect(manifestOf(t, session.id)).toMatchObject({ unreadRegistries: ["banks"] });
    expect(errors.mock.calls.map((call) => String(call[0]))).toContainEqual(expect.stringContaining("The orientation block's banks section did not answer within a second"));
  });

  it("holds at most 6,000 characters: past them, a section's list ends with how many more there are, and where to see them", async () => {
    const banks = Array.from({ length: 200 }, (_, index) => `bank-${String(index).padStart(3, "0")}: a memory bank, landing works.`);
    const environments = ["laptop at https://laptop.example", "mnl at https://mnl.example"];
    const t = await start({
      orientationSections: [
        { name: "banks", title: "Banks", render: () => ["The banks attached here:", { heading: "By name:", items: banks }] },
        { name: "other-environments", title: "Other environments", render: () => [{ items: environments }] },
      ],
    });
    const client = await t.client();
    const session = await create(client);

    const text = await runTo(t, client, session.id);

    expect(text.length).toBeLessThanOrEqual(6000);
    const shown = listOf(text, "By name:");
    const more = /^and (\d+) more, see Settings\.$/.exec(shown.at(-1) ?? "");
    expect(more).not.toBeNull();
    const kept = shown.slice(0, -1);
    expect(kept).toEqual(banks.slice(0, kept.length));
    expect(Number(more?.[1])).toBe(banks.length - kept.length);
    // As many as fit: one more bank's line would pass the cap.
    expect(text.length + `\n- ${banks[kept.length]}`.length).toBeGreaterThan(6000);
    expect(text).toContain("The banks attached here:");
    expect(text.endsWith("## Other environments\n\n- laptop at https://laptop.example\n- mnl at https://mnl.example")).toBe(true);
  });

  it("cuts every list past the cap to the same length, leaving a shorter one whole", async () => {
    const lines = (prefix: string, count: number) => Array.from({ length: count }, (_, index) => `${prefix}-${index}: ${"x".repeat(60)}.`);
    const keyManagers = lines("connection", 120);
    const banks = lines("bank", 90);
    const environments = lines("environment", 4);
    const t = await start({
      orientationSections: [
        { name: "key-managers", title: "Key managers", render: () => [{ items: keyManagers }] },
        { name: "banks", title: "Banks", render: () => [{ items: banks }] },
        { name: "other-environments", title: "Other environments", render: () => [{ items: environments }] },
      ],
    });
    const client = await t.client();
    const session = await create(client);

    const text = await runTo(t, client, session.id);

    expect(text.length).toBeLessThanOrEqual(6000);
    const keyManagerLines = sectionOf(text, "Key managers");
    const bankLines = sectionOf(text, "Banks");
    const kept = keyManagerLines.length - 1;
    expect(kept).toBeGreaterThan(environments.length);
    expect(keyManagerLines).toEqual([...keyManagers.slice(0, kept), `and ${keyManagers.length - kept} more, see Settings.`]);
    expect(bankLines).toEqual([...banks.slice(0, kept), `and ${banks.length - kept} more, see Settings.`]);
    expect(sectionOf(text, "Other environments")).toEqual(environments);
  });

  it("renders a section whose provider answers within the second", async () => {
    let answer: ((content: readonly string[]) => void) | undefined;
    const slow: OrientationSection = { name: "banks", title: "Banks", render: () => new Promise((resolve) => (answer = resolve)) };
    const t = await start({ orientationSections: [slow] });
    const client = await t.client();
    const session = await create(client);
    const untilEnded = await startRun(t, client, session.id);
    await vi.waitFor(() => expect(answer).toBeDefined(), { timeout: WAIT_MS });

    t.clock.advance(999);
    answer?.(["cortex: a memory bank"]);
    const text = await untilEnded();

    expect(text.endsWith("## Banks\n\ncortex: a memory bank")).toBe(true);
    expect(manifestOf(t, session.id)).toMatchObject({ unreadRegistries: [] });
  });
});

describe("the environment section", () => {
  /** The environment section's paragraphs, from its heading to the next section's or the end. */
  const environmentOf = (text: string): string => {
    const start = text.indexOf("## This environment\n\n");
    if (start === -1) throw new Error("No environment section.");
    const rest = text.slice(start + "## This environment\n\n".length);
    const next = rest.indexOf("\n\n## ");
    return next === -1 ? rest : rest.slice(0, next);
  };

  /** The OS user as the machine names it; undefined for a uid with no name (a container's arbitrary user). */
  const osUser = (): string | undefined => {
    try {
      return userInfo().username;
    } catch {
      return undefined;
    }
  };

  it("names the environment, its operating system and architecture, the OS user, and the run's containment level with one line on what it means", async () => {
    const t = await start({ name: "mnl", platform: "linux" });
    const client = await t.client();
    const session = await create(client);

    const text = await runTo(t, client, session.id);

    const user = osUser();
    expect(environmentOf(text)).toBe(
      [
        `This environment is mnl, on Linux (${process.arch}), ${user === undefined ? "as an OS user with no name here" : `as the OS user ${user}`}.`,
        "This run's containment is off: nothing but the denylist limits what its commands and tools read, write or reach.",
      ].join("\n\n"),
    );
  });

  it("names macOS and Windows as people do", async () => {
    for (const [platform, named] of [
      ["darwin", "macOS"],
      ["win32", "Windows"],
    ] as const) {
      const t = await start({ name: "desk", platform });
      const client = await t.client();
      const session = await create(client);

      const text = await runTo(t, client, session.id);

      expect(environmentOf(text)).toContain(`This environment is desk, on ${named} (${process.arch}),`);
    }
  });

  it("states each containment level with what it means, and a different level gives a different text and a fresh process", async () => {
    const t = await start({ containment: bubblewrapProbe() });
    const client = await t.client();
    const session = await create(client, { workspace: { kind: "directory", path: realpathSync(tempDir("agent-harness-workspace-")) } });
    const texts: string[] = [];

    for (const level of ["workspace", "workspace-no-network", "off"] as const) {
      const set = await client.request("permissions.containment.set", { commandId: randomUUID(), sessionId: session.id, level });
      expect(set.receipt).toMatchObject({ status: "accepted" });
      texts.push(await runTo(t, client, session.id, `At ${level}`));
    }

    expect(texts.map((text) => environmentOf(text).split("\n\n")[1])).toEqual([
      "This run's containment is workspace: it reads anywhere but the denylisted paths, writes only in its workspace, its session's scratch directory and its temporary directory, and reaches the network.",
      "This run's containment is workspace-no-network: it reads anywhere but the denylisted paths, writes only in its workspace, its session's scratch directory and its temporary directory, and its commands, fetches and searches reach no host.",
      "This run's containment is off: nothing but the denylist limits what its commands and tools read, write or reach.",
    ]);
    expect(t.adapter.processesOf(session.id).map((process) => process.instructions)).toEqual(texts);
  });

  it("is in instructions.preview as a run is handed it: at the session's own level, and at the default for a new session", async () => {
    const t = await start({ containment: bubblewrapProbe() });
    const client = await t.client();
    const directory = { kind: "directory", path: realpathSync(tempDir("agent-harness-workspace-")) } as const;
    const session = await create(client, { workspace: directory });
    const set = await client.request("permissions.containment.set", { commandId: randomUUID(), sessionId: session.id, level: "workspace-no-network" });
    expect(set.receipt).toMatchObject({ status: "accepted" });

    const previewed = await client.request("instructions.preview", { sessionId: session.id });
    const fresh = await client.request("instructions.preview", { accountId: "claude-max", workspace: directory });
    const handed = await runTo(t, client, session.id);

    expect(environmentOf(previewed.text)).toContain("This run's containment is workspace-no-network: ");
    // A new session names no level of its own: the preset default, workspace, where it can be enforced.
    expect(environmentOf(fresh.text)).toContain("This run's containment is workspace: ");
    expect(handed).toBe(previewed.text);
  });

  it("names the environment as it is now: a rename changes the next run's text", async () => {
    const t = await start({ name: "mnl" });
    const client = await t.client();
    const session = await create(client);
    const before = await runTo(t, client, session.id);

    await client.request("environment.rename", { commandId: randomUUID(), name: "mnl-2" });
    const after = await runTo(t, client, session.id, "After the rename");

    expect(environmentOf(before)).toMatch(/^This environment is mnl, on /);
    expect(environmentOf(after)).toMatch(/^This environment is mnl-2, on /);
    expect(t.adapter.processesOf(session.id)).toHaveLength(2);
  });
});

describe("the instruction scope", () => {
  it("carries the run's injection answer with the level that decided it, asked once and the answer its process environment is built under", async () => {
    const forge = await fakeForge();
    let answer: "allow" | "deny" = "deny";
    const asked: (string | null)[] = [];
    const scopes: InstructionScope[] = [];
    const t = await start({
      forgeFetch: forge.fetch,
      harnessCommand: HELPER,
      adapterSeams: {
        injection: (scope) => {
          asked.push(scope.sessionId);
          return answer;
        },
      },
      orientationSections: [
        {
          name: "key-managers",
          title: "Key managers",
          render: (scope) => {
            scopes.push(scope);
            return [`This run's injection answer is ${scope.injection.answer}, decided at the ${scope.injection.level.kind}'s level.`];
          },
        },
      ],
    });
    const client = await t.client();
    const session = await create(client);

    const denied = await runTo(t, client, session.id);
    answer = "allow";
    const allowed = await runTo(t, client, session.id, "Allowed now");
    const fresh = await client.request("instructions.preview", { accountId: "claude-max", workspace });

    expect(denied).toContain("This run's injection answer is deny, decided at the environment's level.");
    expect(allowed).toContain("This run's injection answer is allow, decided at the environment's level.");
    expect(fresh.text).toContain("This run's injection answer is allow, decided at the environment's level.");
    // One answer per run, asked as it launched; a new session's preview asks for a run in no session yet.
    expect(asked).toEqual([session.id, session.id, null]);
    expect(scopes.map((scope) => scope.injection)).toEqual([
      { answer: "deny", level: { kind: "environment" } },
      { answer: "allow", level: { kind: "environment" } },
      { answer: "allow", level: { kind: "environment" } },
    ]);
    // Each process was built under its run's answer: a denied one is supplied nothing.
    const processes = t.adapter.processesOf(session.id);
    expect(processes.map((process) => (JSON.parse(process.key) as { injection: string }).injection)).toEqual(["deny", "allow"]);
    expect(processes.map((process) => process.instructions)).toEqual([denied, allowed]);
  });
});
