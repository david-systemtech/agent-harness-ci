import { randomUUID } from "node:crypto";
import { GH_MINIMUM_VERSION, forgeTokenPages, type GhProbe, type KeyManagerConnectionRecord, type Scope } from "@agent-harness/contracts";
import { describe, expect, it, onTestFinished } from "vitest";
import { noticeEvent } from "../test/events.js";
import { usePaired } from "../test/paired.js";
import { subscription } from "../test/scripted.js";
import { forgeEventPayload, forgeProblem, forgeRecord } from "../test/forges.js";
import { keyManagerRecord, listedConnection, toolRow, toolsUpdatedPayload } from "../test/key-managers.js";
import { addForgeAlias, addPastedForge, detectForge } from "./forges/actions.js";
import { capabilityName, capabilityStateWords, forgeProblemAction, forgeRefusal, forgeRowProblem, forgeRowState, ghRoute, machineGhLogin, tokenPermissionWords } from "./forges/words.js";
import { createRuntimeWithSeams } from "./internal.js";
import type { Shell } from "./shell.js";
import { fakeWire, flush, type FakeWire } from "./testing/fake-wire.js";
import { MANUAL_CLOCK_START, fakeShell, inMemoryPlatform, manualClock } from "./testing/in-memory-platform.js";

/**
 * Forges in the client runtime (#320; forge spec, "Modules" and "Events";
 * ADR 0020, ADR 0032), through the fake wire: `forge.accounts.list` in the
 * request cache, fetched again on every `forge.account.*` notice.
 */

const { paired: pairedWith, pairedMany: pairedManyWith } = usePaired();

/** A runtime paired with one scripted environment offering the `forge` flag, its environment stream synchronized and held by the test. */
const paired = (options: { readonly capabilities?: readonly string[]; readonly shell?: Shell } = {}) => pairedWith({ capabilities: ["forge"], ...options });

/** A token as a person pastes one: nothing a secret scanner takes for a real one. */
const TOKEN = "token-for-tests";

describe("forge.accounts.list in the request cache", () => {
  it("is fetched again on every forge.account.* notice, and not on a missing origin or one answered", async () => {
    const { runtime, wire, env, environment } = await paired();
    const account = forgeRecord();
    let asked = 0;
    wire.answer("forge.accounts.list", () => {
      asked++;
      return { result: { accounts: [account] } };
    });
    const cached = runtime.requests.cached(env, "forge.accounts.list", {});
    cached.subscribe(() => undefined);
    await flush();
    expect(asked).toBe(1);
    expect(cached.read()).toMatchObject({ result: { accounts: [account] }, error: null });

    const types = [
      "forge.account.added",
      "forge.account.updated",
      "forge.account.primary-set",
      "forge.account.verified",
      "forge.account.capability-learned",
      "forge.account.git-rejected",
      "forge.account.removed",
    ] as const;
    for (const [index, type] of types.entries()) {
      environment.event(noticeEvent(index + 1, env, type, forgeEventPayload(type, account)));
      await flush();
      expect(asked, type).toBe(index + 2);
    }
    environment.event(noticeEvent(types.length + 1, env, "forge.origin-missing", forgeEventPayload("forge.origin-missing", account)));
    environment.event(noticeEvent(types.length + 2, env, "forge.origin-answered", forgeEventPayload("forge.origin-answered", account)));
    await flush();
    expect(asked).toBe(types.length + 1);
  });
});

describe("the forge methods without the forge flag", () => {
  it("answer absent with reason unsupported, sending nothing, and present once the environment offers forge", async () => {
    const { runtime, wire, env } = await paired({ capabilities: [] });
    let asked = 0;
    wire.answer("forge.accounts.list", () => {
      asked++;
      return { result: { accounts: [] } };
    });
    for (const method of ["forge.accounts.list", "forge.accounts.add", "forge.accounts.verify", "forge.gh.probe"] as const) {
      expect(runtime.capability(env, method), method).toEqual({ status: "absent", reason: "unsupported", message: "desk runs an older agent-harness without this. Update desk to use it.", details: ["forge"] });
    }
    expect(await runtime.requests.call(env, "forge.accounts.list", {})).toEqual({
      ok: false,
      error: { code: "unsupported", message: "desk runs an older agent-harness without this. Update desk to use it." },
    });
    const cached = runtime.requests.cached(env, "forge.accounts.list", {});
    cached.subscribe(() => undefined);
    await flush();
    expect(cached.read()).toMatchObject({ result: null, error: { code: "unsupported" } });
    expect(asked).toBe(0);

    const offered = await paired();
    expect(offered.runtime.capability(offered.env, "forge.accounts.list")).toEqual({ status: "present" });
    expect(offered.runtime.capability(offered.env, "forge.accounts.add")).toEqual({ status: "present" });
  });
});

describe("a forge account's token", () => {
  /** `forge.accounts.add`'s params with a pasted token, as `commands.dispatch` would take them: no command id. */
  const toDispatch = () => ({ forgeAccountId: randomUUID(), url: "https://github.com", credential: { kind: "stored", provenance: "pasted", token: TOKEN } }) as const;
  const addParams = () => ({ commandId: randomUUID(), ...toDispatch() });

  it("is sent directly in forge.accounts.add and update, never through the outbox", async () => {
    const { runtime, wire, env, kept } = await paired();
    const account = forgeRecord();
    wire.answer("forge.accounts.add", () => ({ result: { receipt: { status: "accepted", sequence: 1, changed: true }, result: { account } } }));
    wire.answer("forge.accounts.update", () => ({ result: { receipt: { status: "accepted", sequence: 2, changed: true }, result: { account } } }));

    expect(await runtime.commands.dispatch(env, "forge.accounts.add", toDispatch())).toMatchObject({ ok: false, commandId: null, error: { code: "direct" } });
    expect(
      await runtime.commands.dispatch(env, "forge.accounts.update", { forgeAccountId: account.id, credential: { kind: "stored", provenance: "pasted", token: TOKEN } }),
    ).toMatchObject({ ok: false, commandId: null, error: { code: "direct" } });
    expect(wire.server.received().filter((frame) => frame.type === "request" && frame.method.startsWith("forge."))).toEqual([]);

    const add = addParams();
    expect(await runtime.requests.call(env, "forge.accounts.add", add)).toMatchObject({ ok: true, result: { receipt: { status: "accepted" }, result: { account } } });
    const update = { commandId: randomUUID(), forgeAccountId: account.id, credential: { kind: "stored", provenance: "pasted", token: TOKEN } } as const;
    expect(await runtime.requests.call(env, "forge.accounts.update", update)).toMatchObject({ ok: true, result: { receipt: { status: "accepted" } } });
    const sent = wire.server.received().filter((frame) => frame.type === "request" && frame.method.startsWith("forge."));
    expect(sent.map((frame) => frame.type === "request" && [frame.method, frame.params])).toEqual([
      ["forge.accounts.add", add],
      ["forge.accounts.update", update],
    ]);
    await flush();
    expect(kept()).not.toContain(TOKEN);
  });

  it("fails at once while the environment cannot be reached, and nothing holding it is kept on the client", async () => {
    const { runtime, wire, env, kept } = await paired();
    wire.discovery("unreachable");
    wire.server.drop();
    await flush();
    expect(runtime.connections.list.read()[0]?.phase).toBe("backoff");

    expect(await runtime.requests.call(env, "forge.accounts.add", addParams())).toMatchObject({ ok: false, error: { code: "unreachable" } });
    expect(
      await runtime.requests.call(env, "forge.accounts.update", { commandId: randomUUID(), forgeAccountId: randomUUID(), credential: { kind: "stored", provenance: "pasted", token: TOKEN } }),
    ).toMatchObject({ ok: false, error: { code: "unreachable" } });
    expect(await runtime.commands.dispatch(env, "forge.accounts.add", toDispatch())).toMatchObject({ ok: false, commandId: null, error: { code: "direct" } });
    await flush();
    expect(runtime.projections.environments.read()[0]?.pendingCommands).toBe(0);
    expect(kept()).not.toContain(TOKEN);

    // Back again, nothing parked is sent: the environment hears no forge call it was not asked for now.
    wire.discovery({});
    void runtime.connections.retryNow(env);
    await wire.server.accept();
    await flush();
    expect(wire.server.received().filter((frame) => frame.type === "request" && frame.method.startsWith("forge."))).toEqual([]);
  });
});

describe("the forge notices", () => {
  /** What a notice says, and where it points. */
  const shown = (runtime: Awaited<ReturnType<typeof paired>>["runtime"]) =>
    runtime.projections.notices.read().map(({ environmentId, kind, message, action }) => ({ environmentId, kind, message, action }));

  it("raise one row each for a failed capability, a new problem, a git rejection and a missing origin, naming the environment and the origin, offering the Forges step", async () => {
    const { runtime, env, environment } = await paired();
    const account = forgeRecord();
    environment.event(noticeEvent(1, env, "forge.account.added", forgeEventPayload("forge.account.added", account)));
    environment.event(noticeEvent(2, env, "forge.account.capability-learned", forgeEventPayload("forge.account.capability-learned", account)));
    environment.event(
      noticeEvent(3, env, "forge.account.verified", forgeEventPayload("forge.account.verified", account, { problem: forgeProblem("credential-rejected", "GitHub refused the token: give this forge account a new credential in Set up, Forges.") })),
    );
    environment.event(noticeEvent(4, env, "forge.account.git-rejected", forgeEventPayload("forge.account.git-rejected", account)));
    environment.event(noticeEvent(5, env, "forge.origin-missing", forgeEventPayload("forge.origin-missing", account)));
    await flush();

    const forges = { environmentId: env, kind: "forge", action: "setup.forges" } as const;
    expect(shown(runtime)).toEqual([
      { ...forges, message: "https://github.com on desk refused to open an issue (403): its forge account cannot write issues; give it a credential that can in Set up, Forges." },
      { ...forges, message: "https://github.com on desk: GitHub refused the token: give this forge account a new credential in Set up, Forges." },
      { ...forges, message: "git on desk was refused on https://github.com with the forge account's credential, which desk is verifying again." },
      { ...forges, message: "desk was refused on https://git.example.com when it tried to read a skill source: no forge account covers it; add one in Set up, Forges." },
    ]);
  });

  it("withdraw a missing origin's row once the operation it names is answered there, and only that row", async () => {
    const { runtime, env, environment } = await paired();
    const account = forgeRecord();
    const channel = { origin: "https://github.com", operation: "read the release channel" };
    environment.event(noticeEvent(1, env, "forge.origin-missing", forgeEventPayload("forge.origin-missing", account)));
    environment.event(noticeEvent(2, env, "forge.origin-missing", forgeEventPayload("forge.origin-missing", account, channel)));
    await flush();
    expect(shown(runtime)).toHaveLength(2);

    environment.event(noticeEvent(3, env, "forge.origin-answered", forgeEventPayload("forge.origin-answered", account, { origin: channel.origin, operation: "read a skill source" })));
    environment.event(noticeEvent(4, env, "forge.origin-answered", forgeEventPayload("forge.origin-answered", account, channel)));
    await flush();
    expect(shown(runtime)).toEqual([
      {
        environmentId: env,
        kind: "forge",
        action: "setup.forges",
        message: "desk was refused on https://git.example.com when it tried to read a skill source: no forge account covers it; add one in Set up, Forges.",
      },
    ]);
  });

  it("raise none for an account added, verified or learning a capability with nothing wrong, nor for its primary set or its removal", async () => {
    const { runtime, env, environment } = await paired();
    const account = forgeRecord();
    const events = [
      noticeEvent(1, env, "forge.account.added", forgeEventPayload("forge.account.added", account)),
      noticeEvent(2, env, "forge.account.verified", forgeEventPayload("forge.account.verified", account)),
      noticeEvent(3, env, "forge.account.capability-learned", forgeEventPayload("forge.account.capability-learned", account, { state: "verified", status: 201 })),
      noticeEvent(4, env, "forge.account.updated", forgeEventPayload("forge.account.updated", account, { slug: "gh" })),
      noticeEvent(5, env, "forge.account.primary-set", forgeEventPayload("forge.account.primary-set", account)),
      noticeEvent(6, env, "forge.account.removed", forgeEventPayload("forge.account.removed", account)),
    ];
    for (const event of events) environment.event(event);
    await flush();
    expect(shown(runtime)).toEqual([]);
  });

  it("raise a problem only when it is new: of another kind than the one last heard for that forge account, or on an add", async () => {
    const { runtime, env, environment } = await paired();
    const account = forgeRecord();
    const copy = forgeRecord({ origin: "https://git.example.com", slug: "git_example_com", primary: false });
    const verified = (sequence: number, problem: ReturnType<typeof forgeProblem> | null, fields: Record<string, unknown> = {}) =>
      noticeEvent(sequence, env, "forge.account.verified", forgeEventPayload("forge.account.verified", account, { problem, ...fields }));
    const events = [
      noticeEvent(1, env, "forge.account.added", forgeEventPayload("forge.account.added", account)),
      verified(2, forgeProblem("expiring", "The token expires at 2026-10-01 12:00 UTC: replace it in Set up, Forges before then.")),
      // Still expiring, a read found failed beside it: not a new problem.
      verified(3, forgeProblem("expiring", "The token expires at 2026-10-01 12:00 UTC: replace it in Set up, Forges before then."), {
        capabilities: { ...account.capabilities, readReleases: { state: "failed", verifiedAt: null, status: 403 } },
      }),
      verified(4, forgeProblem("credential-rejected", "GitHub refused the token: give this forge account a new credential in Set up, Forges.")),
      verified(5, null),
      verified(6, forgeProblem("credential-rejected", "GitHub refused the token again: give this forge account a new credential in Set up, Forges.")),
      // A credential replaced, whose forge does not answer.
      noticeEvent(7, env, "forge.account.updated", forgeEventPayload("forge.account.updated", account, { credential: account.credential, problem: forgeProblem("unreachable", "github.com did not answer.") })),
      // A copy added awaiting a credential here.
      noticeEvent(
        8,
        env,
        "forge.account.added",
        forgeEventPayload("forge.account.added", copy, {
          credential: { kind: "none" },
          identity: null,
          problem: forgeProblem("needs-credential", "This forge account has no credential on this environment: give it one in Set up, Forges."),
          copiedFrom: { environmentId: randomUUID(), environmentName: "laptop" },
        }),
      ),
    ];
    for (const event of events) environment.event(event);
    await flush();
    expect(shown(runtime).map((notice) => notice.message)).toEqual([
      "https://github.com on desk: The token expires at 2026-10-01 12:00 UTC: replace it in Set up, Forges before then.",
      "https://github.com on desk: GitHub refused the token: give this forge account a new credential in Set up, Forges.",
      "https://github.com on desk: GitHub refused the token again: give this forge account a new credential in Set up, Forges.",
      "https://github.com on desk: github.com did not answer.",
      "https://git.example.com on desk: This forge account has no credential on this environment: give it one in Set up, Forges.",
    ]);
  });

  it("raise none for what a replay onto an empty cache holds, which is history, and read it for the origins it names", async () => {
    const clock = manualClock();
    const wire = fakeWire({ clock, name: "desk", capabilities: ["forge"] });
    for (const method of ["sessions.subscribe", "environment.subscribe"]) wire.answer(method, () => undefined);
    let asked = 0;
    wire.answer("forge.accounts.list", () => {
      asked++;
      return { result: { accounts: [] } };
    });
    const { runtime } = createRuntimeWithSeams(inMemoryPlatform({ clock, fetch: wire.fetch, webSocket: wire.webSocket }));
    onTestFinished(() => runtime.close());
    await runtime.start();
    const adding = runtime.connections.add({ link: wire.link });
    await wire.server.accept();
    (await subscription(wire, "sessions.subscribe")).synchronized(0);
    const environment = await subscription(wire, "environment.subscribe");
    const env = wire.environmentId;
    const account = forgeRecord();
    const history = [
      noticeEvent(1, env, "forge.account.added", forgeEventPayload("forge.account.added", account)),
      noticeEvent(2, env, "forge.account.capability-learned", forgeEventPayload("forge.account.capability-learned", account)),
      noticeEvent(3, env, "forge.account.verified", forgeEventPayload("forge.account.verified", account, { problem: forgeProblem("credential-rejected") })),
      noticeEvent(4, env, "forge.account.git-rejected", forgeEventPayload("forge.account.git-rejected", account)),
      noticeEvent(5, env, "forge.origin-missing", forgeEventPayload("forge.origin-missing", account)),
    ];
    for (const event of history) environment.event(event);
    environment.synchronized(history.length);
    await adding;
    await flush();
    expect(shown(runtime)).toEqual([]);

    // News after it: the origin is the one history named, with no read of the list; and the problem, still of the kind heard, is not new.
    environment.event(noticeEvent(6, env, "forge.account.capability-learned", forgeEventPayload("forge.account.capability-learned", account, { capability: "pullRequests", operation: "open a pull request" })));
    environment.event(noticeEvent(7, env, "forge.account.verified", forgeEventPayload("forge.account.verified", account, { problem: forgeProblem("credential-rejected") })));
    await flush();
    expect(shown(runtime).map((notice) => notice.message)).toEqual([
      "https://github.com on desk refused to open a pull request (403): its forge account cannot work with pull requests; give it a credential that can in Set up, Forges.",
    ]);
    expect(asked).toBe(0);
  });

  it("read the forge accounts for an origin not heard, raising the row once they answer, in the order the rows were heard", async () => {
    const { runtime, wire, env, environment } = await paired();
    const account = forgeRecord({ origin: "https://git.example.com:8443", kind: "forgejo", slug: "git_example_com" });
    let answer: (accounts: readonly ReturnType<typeof forgeRecord>[]) => void = () => undefined;
    let asked = 0;
    wire.answer("forge.accounts.list", () => {
      asked++;
      return new Promise((resolve) => (answer = (accounts) => resolve({ result: { accounts } })));
    });
    // Its add was before this client's cursor: nothing here names its origin.
    environment.event(noticeEvent(1, env, "forge.account.capability-learned", forgeEventPayload("forge.account.capability-learned", account)));
    environment.event(noticeEvent(2, env, "forge.origin-missing", forgeEventPayload("forge.origin-missing", account)));
    environment.event(noticeEvent(3, env, "forge.account.verified", forgeEventPayload("forge.account.verified", account, { problem: forgeProblem("unreachable", "git.example.com did not answer.") })));
    await flush();
    expect(shown(runtime)).toEqual([]);
    expect(asked).toBe(1);

    answer([account]);
    await flush();
    expect(shown(runtime).map((notice) => notice.message)).toEqual([
      "https://git.example.com:8443 on desk refused to open an issue (403): its forge account cannot write issues; give it a credential that can in Set up, Forges.",
      "desk was refused on https://git.example.com when it tried to read a skill source: no forge account covers it; add one in Set up, Forges.",
      "https://git.example.com:8443 on desk: git.example.com did not answer.",
    ]);
    expect(asked).toBe(1);

    // One the environment no longer holds is said all the same, without its origin.
    const gone = forgeRecord();
    environment.event(noticeEvent(4, env, "forge.account.capability-learned", forgeEventPayload("forge.account.capability-learned", gone)));
    await flush();
    answer([account]);
    await flush();
    expect(shown(runtime).at(-1)?.message).toBe(
      "A forge on desk refused to open an issue (403): its forge account cannot write issues; give it a credential that can in Set up, Forges.",
    );
  });
});

describe("a forge notice heard while catching up", () => {
  it("waits for the connection to be ready before reading the forge accounts, and then names the origin", async () => {
    const { runtime, wire, env, environment } = await paired();
    const account = forgeRecord({ origin: "https://git.example.com", kind: "forgejo", slug: "git_example_com" });
    let asked = 0;
    wire.answer("forge.accounts.list", () => {
      asked++;
      return { result: { accounts: [account] } };
    });
    environment.event(noticeEvent(1, env, "forge.account.primary-set", forgeEventPayload("forge.account.primary-set", account)));
    await flush();

    // The link drops; back again, the environment stream catches up from its cursor while the session list is still syncing.
    wire.server.drop();
    await flush();
    void runtime.connections.retryNow(env);
    await wire.server.accept();
    const list = await subscription(wire, "sessions.subscribe");
    const caughtUp = await subscription(wire, "environment.subscribe");
    expect(caughtUp.params).toMatchObject({ afterSequence: 1 });
    caughtUp.event(noticeEvent(2, env, "forge.account.capability-learned", forgeEventPayload("forge.account.capability-learned", account)));
    caughtUp.synchronized(2);
    await flush();
    expect(runtime.connections.list.read()[0]?.phase).toBe("syncing");
    expect(runtime.projections.notices.read()).toEqual([]);
    expect(asked).toBe(0);

    list.synchronized(0);
    await flush();
    expect(asked).toBe(1);
    expect(runtime.projections.notices.read().map((notice) => notice.message)).toEqual([
      "https://git.example.com on desk refused to open an issue (403): its forge account cannot write issues; give it a credential that can in Set up, Forges.",
    ]);
  });
});

describe("handing this computer's gh over", () => {
  /** The forge requests the environment heard, as method and params. */
  const forgeRequests = (wire: FakeWire) =>
    wire.server.received().flatMap((frame) => (frame.type === "request" && frame.method.startsWith("forge.") ? [[frame.method, frame.params] as const] : []));

  const accepting = (wire: FakeWire) => {
    const account = forgeRecord();
    wire.answer("forge.accounts.add", () => ({ result: { receipt: { status: "accepted", sequence: 1, changed: true }, result: { account } } }));
    return account;
  };

  it("reads gh's token for the forge's host and sends it once, in forge.accounts.add as a stored credential from this client's gh, keeping it nowhere", async () => {
    const shell = fakeShell();
    shell.answer("gh.token", async (host) => (host === "github.com" ? TOKEN : undefined));
    const { runtime, wire, env, kept } = await paired({ shell });
    const account = accepting(wire);

    const answer = await runtime.forges.handOverGh(env, { url: "git@github.com:david/bank.git", primary: true });
    expect(answer).toEqual({ ok: true, result: { receipt: { status: "accepted", sequence: 1, changed: true }, result: { account } } });
    expect(shell.calls.filter(([member]) => member === "gh.token")).toEqual([["gh.token", "github.com"]]);
    expect(forgeRequests(wire)).toEqual([
      [
        "forge.accounts.add",
        {
          commandId: expect.stringMatching(/^[0-9a-f-]{36}$/),
          forgeAccountId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
          url: "git@github.com:david/bank.git",
          primary: true,
          credential: { kind: "stored", provenance: "client-gh", token: TOKEN },
        },
      ],
    ]);
    await flush();
    expect(kept()).not.toContain(TOKEN);
  });

  it("names an Enterprise host with its port to gh", async () => {
    const shell = fakeShell();
    shell.answer("gh.token", async () => TOKEN);
    const { runtime, wire, env } = await paired({ shell });
    accepting(wire);
    expect(await runtime.forges.handOverGh(env, { url: "https://GHE.example.com:8443/org/repo.git", kind: "github" })).toMatchObject({ ok: true });
    expect(shell.calls.filter(([member]) => member === "gh.token")).toEqual([["gh.token", "ghe.example.com:8443"]]);
  });

  it("is absent with its reason where the shell has no gh, as in the terminal UI and a browser tab, reading and sending nothing", async () => {
    const { runtime, wire, env } = await paired();
    accepting(wire);
    expect(runtime.capability(env, "shell.gh")).toEqual({ status: "absent", reason: "no-shell", message: "This app cannot use the gh tool signed in on this computer here. Add a token instead.", details: ["shell.gh"] });
    expect(await runtime.forges.handOverGh(env, { url: "https://github.com" })).toEqual({
      ok: false,
      error: { code: "no-shell", message: "This app cannot use the gh tool signed in on this computer here. Add a token instead." },
    });
    expect(forgeRequests(wire)).toEqual([]);
  });

  it("fails sending nothing when gh gives no token for the host, when it fails, or when the URL is no forge's", async () => {
    const shell = fakeShell();
    const { runtime, wire, env } = await paired({ shell });
    accepting(wire);
    expect(await runtime.forges.handOverGh(env, { url: "https://github.com" })).toEqual({
      ok: false,
      error: { code: "gh-unavailable", message: "The gh on this computer is not signed in to github.com: run gh auth login --hostname github.com here, or paste a token." },
    });
    shell.answer("gh.token", async () => {
      throw new Error("gh exited with status 4");
    });
    expect(await runtime.forges.handOverGh(env, { url: "https://github.com" })).toEqual({
      ok: false,
      error: { code: "gh-failed", message: "The gh on this computer could not be read: gh exited with status 4" },
    });
    shell.answer("gh.token", async () => TOKEN);
    expect(await runtime.forges.handOverGh(env, { url: "/home/david/bank" })).toMatchObject({ ok: false, error: { code: "invalid_params" } });
    expect(forgeRequests(wire)).toEqual([]);
    expect(shell.calls.filter(([member]) => member === "gh.token")).toHaveLength(2);
  });

  it("fails at once, reading nothing from gh, while the environment cannot take the add", async () => {
    const shell = fakeShell();
    shell.answer("gh.token", async () => TOKEN);
    const { runtime, wire, env } = await paired({ shell });
    wire.discovery("unreachable");
    wire.server.drop();
    await flush();
    expect(await runtime.forges.handOverGh(env, { url: "https://github.com" })).toMatchObject({ ok: false, error: { code: "unreachable" } });
    expect(shell.calls.filter(([member]) => member === "gh.token")).toEqual([]);

    const bare = await paired({ capabilities: [], shell });
    expect(await bare.runtime.forges.handOverGh(bare.env, { url: "https://github.com" })).toMatchObject({ ok: false, error: { code: "unsupported" } });
    expect(shell.calls.filter(([member]) => member === "gh.token")).toEqual([]);
  });
});

/** A runtime paired with a scripted environment per entry, each offering `forge` and granting its scopes (every scope when absent). */
const pairedMany = (environments: readonly { readonly name: string; readonly scopes?: readonly Scope[] }[]) => pairedManyWith(["forge", "keyManagers"], environments);

/** Answers every forge.accounts.add accepted, with the account it would add, and records what each was asked. */
const acceptingAdds = (wire: FakeWire) => {
  const asked: Record<string, unknown>[] = [];
  wire.answer("forge.accounts.add", (params) => {
    asked.push(params);
    const account = forgeRecord({ id: params["forgeAccountId"] as string });
    return { result: { receipt: { status: "accepted", sequence: asked.length, changed: true }, result: { account } } };
  });
  return asked;
};

/** Answers `keyManagers.list` on `wire` with `connections`. */
const listingConnections = (wire: FakeWire, ...connections: KeyManagerConnectionRecord[]) =>
  wire.answer("keyManagers.list", () => ({ result: { connections: connections.map((connection) => listedConnection(connection)) } }));

describe("copying a forge account to other environments", () => {
  const reference = { provider: "openbao", connectionId: randomUUID(), mount: "personal", path: "harness/forge-github", key: "token" } as const;

  it("calls forge.accounts.add on each chosen environment with its origin, aliases, kind, slug, primary and source: a reference through that environment's own connection to its key manager, a stored token as none, gh as gh", async () => {
    const { runtime, wires, ids } = await pairedMany([{ name: "desk" }, { name: "laptop" }, { name: "server" }]);
    const [desk, laptop, server] = ids as [string, string, string];
    const [deskWire, laptopWire, serverWire] = wires as [FakeWire, FakeWire, FakeWire];
    const onLaptop = acceptingAdds(laptopWire);
    const onServer = acceptingAdds(serverWire);
    // Each environment's connection to the one OpenBao has an id of its own; the server holds another key manager besides.
    listingConnections(deskWire, keyManagerRecord({ id: reference.connectionId }));
    const laptopConnection = keyManagerRecord({ copiedFrom: { environmentId: desk, environmentName: "desk" } });
    listingConnections(laptopWire, laptopConnection);
    const serverConnection = keyManagerRecord();
    listingConnections(serverWire, keyManagerRecord({ address: "https://people.example.com" }), serverConnection);
    const stored = forgeRecord({ aliases: [{ origin: "http://100.64.0.7:3000", verifiedAt: null }] });
    const forgejo = forgeRecord({ origin: "https://git.example.com", kind: "forgejo", slug: "git_example_com", primary: false, credential: { kind: "reference", reference } });
    const gh = forgeRecord({ origin: "https://ghe.example.com", slug: "ghe_example_com", primary: false, credential: { kind: "gh", login: "david" } });

    // One after another, so each environment's adds arrive in the accounts' order.
    const reports = [];
    for (const account of [stored, forgejo, gh]) reports.push(...(await runtime.forges.copy(desk, account, [laptop, server])));
    expect(reports.map(({ environmentId, status }) => [environmentId, status])).toEqual([
      [laptop, "copied"],
      [server, "copied"],
      [laptop, "copied"],
      [server, "copied"],
      [laptop, "copied"],
      [server, "copied"],
    ]);
    const copiedFrom = { environmentId: desk, environmentName: "desk" };
    const expected = (connectionId: string) => [
      { url: "https://github.com", kind: "github", slug: "github", aliases: ["http://100.64.0.7:3000"], primary: true, credential: { kind: "none" }, copiedFrom },
      { url: "https://git.example.com", kind: "forgejo", slug: "git_example_com", aliases: [], primary: false, credential: { kind: "reference", reference: { ...reference, connectionId } }, copiedFrom },
      { url: "https://ghe.example.com", kind: "github", slug: "ghe_example_com", aliases: [], primary: false, credential: { kind: "gh", login: "david" }, copiedFrom },
    ];
    for (const [asked, connectionId] of [
      [onLaptop, laptopConnection.id],
      [onServer, serverConnection.id],
    ] as const) {
      expect(asked).toEqual(expected(connectionId).map((params) => ({ ...params, commandId: expect.any(String), forgeAccountId: expect.any(String) })));
      // A copy is a new forge account there: its own id, never the source's.
      expect(asked.map((params) => params["forgeAccountId"])).not.toContain(stored.id);
    }
    expect(JSON.stringify([onLaptop, onServer])).not.toContain(stored.credential.kind === "stored" ? stored.credential.entry : "");
  });

  it("refuses a reference, sending nothing, where the environment holds no connection to its key manager, and everywhere when the source cannot say which that is; the others take it", async () => {
    const { runtime, wires, ids } = await pairedMany([{ name: "desk" }, { name: "laptop" }, { name: "server" }, { name: "attic" }]);
    const [desk, laptop, server, attic] = ids as [string, string, string, string];
    const [deskWire, laptopWire, serverWire, atticWire] = wires as [FakeWire, FakeWire, FakeWire, FakeWire];
    const onLaptop = acceptingAdds(laptopWire);
    const onServer = acceptingAdds(serverWire);
    listingConnections(deskWire, keyManagerRecord({ id: reference.connectionId, label: "Agent box vault" }));
    // The laptop holds OpenBao elsewhere, and another provider at the same address: neither is the key manager the reference is read through.
    listingConnections(
      laptopWire,
      keyManagerRecord({ address: "https://people.example.com" }),
      keyManagerRecord({ provider: "doppler", ca: null, method: null, mount: null, ticks: null, basePath: "harness", policies: null }),
    );
    listingConnections(serverWire, keyManagerRecord());
    atticWire.discovery("unreachable");
    atticWire.server.drop();
    await flush();
    const account = forgeRecord({ origin: "https://git.example.com", kind: "forgejo", slug: "git_example_com", credential: { kind: "reference", reference } });

    const reports = await runtime.forges.copy(desk, account, [laptop, server, attic]);
    expect(reports.map(({ environmentId, status }) => [environmentId, status])).toEqual([
      [laptop, "refused"],
      [server, "copied"],
      [attic, "refused"],
    ]);
    expect(reports[0]).toEqual({
      environmentId: laptop,
      status: "refused",
      error: {
        code: "credential_source_unavailable",
        message: "laptop holds no connection to Agent box vault at https://bao.example.com:8200: copy that key-manager connection there and sign it in, then copy again.",
        data: { connectionId: reference.connectionId },
      },
    });
    expect(reports[2]).toMatchObject({ error: { code: "unreachable" } });
    expect(onLaptop).toEqual([]);
    expect(onServer).toHaveLength(1);

    // The source no longer holds the connection the reference names, then cannot be asked: no target can be told which key manager to read it through.
    listingConnections(deskWire);
    const gone = await runtime.forges.copy(desk, account, [laptop, server]);
    const noConnection = `The reference is read through the key-manager connection ${reference.connectionId}, which desk does not hold.`;
    expect(gone).toEqual(
      [laptop, server].map((environmentId) => ({
        environmentId,
        status: "refused",
        error: { code: "credential_source_unavailable", message: noConnection, data: { connectionId: reference.connectionId } },
      })),
    );
    deskWire.answer("keyManagers.list", () => ({ error: { code: "internal", message: "The connections could not be read.", data: {} } }));
    const unasked = await runtime.forges.copy(desk, account, [server]);
    expect(unasked).toEqual([
      {
        environmentId: server,
        status: "refused",
        error: {
          code: "credential_source_unavailable",
          message: "desk could not say which key manager the reference is read through: The connections could not be read.",
          data: { connectionId: reference.connectionId },
        },
      },
    ]);
    expect(onLaptop).toEqual([]);
    expect(onServer).toHaveLength(1);
  });

  it("reports each environment on its own, going on past one that refuses it, cannot be reached, or was paired without admin", async () => {
    const { runtime, wires, ids } = await pairedMany([{ name: "desk" }, { name: "laptop" }, { name: "server" }, { name: "phone", scopes: ["read", "sessions:write"] }, { name: "attic" }]);
    const [desk, laptop, server, phone, attic] = ids as [string, string, string, string, string];
    const [, laptopWire, serverWire, , atticWire] = wires as [FakeWire, FakeWire, FakeWire, FakeWire, FakeWire];
    acceptingAdds(laptopWire);
    serverWire.answer("forge.accounts.add", () => ({
      result: {
        receipt: { status: "rejected", sequence: 3, changed: false, reason: "conflict", error: { code: "conflict", message: "https://github.com is held by another forge account.", data: { reason: "origin_held" } } },
      },
    }));
    atticWire.discovery("unreachable");
    atticWire.server.drop();
    await flush();

    const account = forgeRecord();
    const reports = await runtime.forges.copy(desk, account, [laptop, server, phone, attic, randomUUID()]);
    expect(reports.map(({ environmentId, status }) => [environmentId, status])).toEqual([
      [laptop, "copied"],
      [server, "refused"],
      [phone, "refused"],
      [attic, "refused"],
      [expect.any(String), "refused"],
    ]);
    const [copied, conflict, scope, unreachable, unknown] = reports;
    expect(copied).toMatchObject({ status: "copied", result: { id: expect.any(String), origin: "https://github.com" } });
    expect(conflict).toMatchObject({ error: { code: "conflict", message: "https://github.com is held by another forge account.", data: { reason: "origin_held" } } });
    expect(scope).toMatchObject({ error: { code: "scope", message: "This app has limited access to phone, so it cannot change settings or sign in accounts. Pair again with full access to change this." } });
    expect(unreachable).toMatchObject({ error: { code: "unreachable" } });
    expect(unknown).toMatchObject({ error: { code: "unreachable" } });
  });

  it("offers every other enabled environment this client holds an admin connection to", async () => {
    const { runtime, ids } = await pairedMany([{ name: "desk" }, { name: "laptop" }, { name: "phone", scopes: ["read"] }, { name: "server" }, { name: "attic" }]);
    const [desk, laptop, , server, attic] = ids as [string, string, string, string, string];
    const targets = runtime.projections.copyTargets(desk);
    expect(runtime.projections.copyTargets(desk)).toBe(targets);
    expect(targets.read()).toEqual([
      { environmentId: laptop, name: "laptop" },
      { environmentId: server, name: "server" },
      { environmentId: attic, name: "attic" },
    ]);
    const heard: unknown[] = [];
    targets.subscribe((value) => heard.push(value));
    await runtime.connections.setEnabled(attic, false);
    expect(heard.at(-1)).toEqual([
      { environmentId: laptop, name: "laptop" },
      { environmentId: server, name: "server" },
    ]);
    expect(runtime.projections.copyTargets(laptop).read().map((target) => target.environmentId)).toEqual([desk, server]);
  });
});

describe("forge.gh.probe in the request cache", () => {
  it("is fetched again when the managed tools change, whose gh row it reads (#589)", async () => {
    const { runtime, wire, env, environment } = await paired();
    let asked = 0;
    wire.answer("forge.gh.probe", () => (asked++, { result: { installed: false, version: null, minimum: GH_MINIMUM_VERSION, meetsMinimum: false, accounts: [] } }));
    runtime.requests.cached(env, "forge.gh.probe", {}).subscribe(() => undefined);
    await flush();
    expect(asked).toBe(1);
    environment.event(noticeEvent(1, env, "tools.updated", toolsUpdatedPayload(toolRow({ version: "2.2.0" }))));
    await flush();
    expect(asked).toBe(2);
  });
});

describe("the Forges step's row (#589)", () => {
  it("offers Check again on an unreachable forge, the Key manager step for a reference it cannot read, Sign in again on every other problem, and draws no expiry", () => {
    const reference = forgeRecord({
      credential: { kind: "reference", reference: { provider: "openbao", connectionId: randomUUID(), mount: "personal", path: "harness/forge-github", key: "token" } },
      problem: forgeProblem("credential-unavailable"),
    });
    expect(forgeProblemAction(forgeRecord())).toBeNull();
    expect(forgeProblemAction(forgeRecord({ problem: forgeProblem("unreachable") }))).toBe("check-again");
    expect(forgeProblemAction(reference)).toBe("key-manager");
    expect(forgeProblemAction({ ...reference, problem: forgeProblem("credential-rejected") })).toBe("sign-in-again");
    for (const kind of ["needs-credential", "credential-rejected", "credential-unavailable", "identity-changed"] as const) {
      expect(forgeProblemAction(forgeRecord({ problem: forgeProblem(kind) })), kind).toBe("sign-in-again");
    }
    // The card's expiry warning is milestone 2's (ADR 0033): the row draws none.
    const expiring = forgeRecord({ problem: forgeProblem("expiring") });
    expect(forgeRowProblem(expiring)).toBeNull();
    expect(forgeProblemAction(expiring)).toBeNull();
    expect(forgeRowProblem(forgeRecord({ problem: forgeProblem("unreachable") }))).toMatchObject({ kind: "unreachable" });
  });

  it("offers the environment's own gh first once it is installed at the minimum and signed in, reading the host's active login; else Install gh, Update gh or how to sign it in (#1849)", () => {
    const probe = (fields: Partial<GhProbe>): GhProbe => ({ installed: true, version: "2.63.2", minimum: GH_MINIMUM_VERSION, meetsMinimum: true, accounts: [], ...fields });
    const account = (host: string, login: string, active: boolean) => ({ host, login, active, tokenKind: "oauth" as const, scopes: ["repo"] });
    expect(ghRoute(probe({ installed: false, version: null, meetsMinimum: false }), "this computer")).toEqual({
      kind: "install", line: "The gh tool is not installed. Install it to use your GitHub sign-in.", details: ["Needs gh 2.40.0 or later."],
    });
    expect(ghRoute(probe({ version: "2.30.0", meetsMinimum: false }), "this computer")).toEqual({ kind: "update", line: "The gh tool is out of date.", details: ["gh 2.30.0 (needs 2.40.0 or later)"] });
    expect(ghRoute(probe({}), "laptop")).toEqual({
      kind: "signed-out", line: "The gh tool is not signed in to github.com. Run gh auth login on laptop, or add a token instead.", details: ["gh auth login --hostname github.com"],
    });
    const signedIn = probe({ accounts: [account("ghe.example.test:8443", "dvd", true), account("github.com", "milo", false), account("github.com", "david", true)] });
    expect(ghRoute(signedIn, "this computer")).toEqual({ kind: "use", host: "github.com", login: "david", line: "Use your GitHub sign-in from the gh tool (david)" });
    expect(ghRoute(probe({ accounts: [account("ghe.example.test:8443", "dvd", false)] }), "this computer")).toMatchObject({ kind: "use", host: "ghe.example.test:8443", login: "dvd" });
    expect(machineGhLogin(signedIn, "github.com")).toBe("david");
    expect(machineGhLogin(signedIn, "ghe.example.test:8443")).toBe("dvd");
    expect(machineGhLogin(signedIn, "git.example.test")).toBeNull();
  });

  it("sends an alias with the aliases the environment holds when it is sent, so one added before the row's record is read again is kept", async () => {
    const { runtime, clock, wire, env } = await paired();
    // The row's record as the request cache held it before either alias: the cache reads the list again only once it hears the update's event.
    const shown = forgeRecord({ origin: "https://git.example.test", kind: "forgejo", slug: "git_example_test" });
    let held = shown;
    let sequence = 0;
    wire.answer("forge.accounts.list", () => ({ result: { accounts: [held] } }));
    wire.answer("forge.accounts.update", (params) => {
      held = { ...held, aliases: (params["aliases"] as readonly string[]).map((origin) => ({ origin, verifiedAt: clock.now().toISOString() })) };
      return { result: { receipt: { status: "accepted", sequence: ++sequence, changed: true }, result: { account: held } } };
    });
    const sender = { runtime, clock };

    expect(await addForgeAlias(sender, env, shown, "http://forge.tail.test:3000")).toMatchObject({ ok: true });
    expect(await addForgeAlias(sender, env, shown, "http://forge.lan.test:3000/david/agent-harness.git")).toMatchObject({ ok: true });
    expect(held.aliases.map((alias) => alias.origin)).toEqual(["http://forge.tail.test:3000", "http://forge.lan.test:3000"]);

    // One the environment holds already is refused, sending no update, though the row's record does not list it yet.
    expect(await addForgeAlias(sender, env, shown, "http://forge.tail.test:3000")).toEqual({ ok: false, line: "forge.tail.test:3000 is already another address for this site.", details: [] });
    expect(wire.server.received().filter((frame) => frame.type === "request" && frame.method === "forge.accounts.update")).toHaveLength(2);
  });
});

describe("the Forges card's words (#1849)", () => {
  it("names each capability and where it stands in words, with no HTTP status", () => {
    expect(["readRepository", "pullRequests", "writeIssues", "createRepository", "readReleases"].map((name) => capabilityName(name as "readRepository"))).toEqual([
      "Read code", "Open pull requests", "Write issues", "Create repositories", "Read releases",
    ]);
    expect(capabilityStateWords({ state: "verified" })).toBe("Works");
    expect(capabilityStateWords({ state: "failed" })).toBe("Not allowed");
    expect(capabilityStateWords({ state: "unknown" })).toBe("Not checked yet");
  });

  it("gives a row a state word: needing a fix with a problem it draws, checking until its code is read, else done", () => {
    const unread = forgeRecord();
    const read = forgeRecord({ capabilities: { ...unread.capabilities, readRepository: { state: "verified", verifiedAt: MANUAL_CLOCK_START, status: null } } });
    expect(forgeRowState(read)).toBe("done");
    expect(forgeRowState({ ...read, problem: forgeProblem("credential-rejected") })).toBe("needs-attention");
    expect(forgeRowState({ ...read, problem: forgeProblem("expiring") })).toBe("done");
    expect(forgeRowState(unread)).toBe("pending");
  });

  it("says the permissions to give a token in the words its page shows", () => {
    const [fineGrained, classic] = forgeTokenPages("github", "https://github.com");
    expect(tokenPermissionWords(fineGrained!)).toBe("All repositories, with Contents: Read and write, Issues: Read and write, Pull requests: Read and write and Administration: Read and write");
    expect(tokenPermissionWords(classic!)).toBe("repo and read:org");
    expect(tokenPermissionWords(forgeTokenPages("forgejo", "https://git.example.test")[0]!)).toBe("User: Read, Repository: Read and write, Issue: Read and write and Organization: Read and write");
  });

  it("words the forge's refusals as setup-copy.md §5.6 says, naming the site, and every other through the refusal mapper, the raw words in details", () => {
    const site = "code.example.test";
    const line = (code: string, data?: Record<string, unknown>) => forgeRefusal({ code, message: "raw words", ...(data !== undefined && { data }) }, site, "Add code.example.test").line;
    expect(line("kind_unsupported", { origin: "https://gitlab.com", kind: "gitlab" })).toBe("GitLab is not supported yet.");
    expect(line("not_a_forge", { origin: "https://code.example.test" })).toBe("agent-harness does not recognise this site. Choose what it runs.");
    expect(line("unreachable", { origin: "https://code.example.test" })).toBe("agent-harness could not reach code.example.test. Check the address and the internet connection.");
    expect(line("conflict", { reason: "origin_held" })).toBe("code.example.test is already connected.");
    expect(line("verification_failed", { origin: "https://code.example.test", status: 401 })).toBe("code.example.test did not accept this token. Check that you copied all of it, or create a new one.");
    expect(line("gh-unavailable")).toBe("The gh tool is not signed in to code.example.test.");
    // A gh that is signed in but fails to give its token is not told to sign in; its own cause is in Details.
    expect(line("gh-failed")).toBe("The gh tool did not give a token for code.example.test.");
    expect(forgeRefusal({ code: "gh-failed", message: "The gh on this computer could not be read: gh exited with status 4" }, site, "Use gh").details).toEqual([
      "gh-failed: The gh on this computer could not be read: gh exited with status 4",
    ]);
    expect(line("identity_mismatch", { expected: { login: "david", userId: "42" }, found: { login: "milo", userId: "7" } })).toBe("This token belongs to milo, not david. Add a token for david.");
    expect(line("alias_identity_mismatch", { expected: { login: "david", userId: "42" }, found: null, status: 401 })).toBe(
      "code.example.test did not accept the token for david, so it is not another address for this site. Nothing was changed.",
    );
    // The lost connection is this client's own unreachable, and an unknown refusal says to try again.
    expect(line("unreachable")).toBe("This app cannot reach that computer right now. Choose Add code.example.test to try again.");
    expect(line("conflict", { reason: "slug_taken" })).toBe("This cannot be done right now. Wait a moment, then choose Add code.example.test.");
    expect(line("mystery", {})).toBe("Something went wrong. Choose Add code.example.test to try again.");
    expect(forgeRefusal({ code: "verification_failed", message: "refused", data: { status: 401, details: ["HTTP 401 Bad credentials"] } }, site, "Add").details).toEqual([
      "verification_failed: refused", "HTTP 401 Bad credentials",
    ]);
  });

  it("says a detection that answered as no forge it knows as unrecognised, so the person names the kind, and sends the kind they named with the add", async () => {
    const { runtime, clock, wire, env } = await paired();
    wire.answer("forge.detect", () => ({ error: { code: "not_a_forge", message: "agent-harness does not recognise this site. Choose what it runs.", data: { origin: "https://code.example.test" } } }));
    let sent: Record<string, unknown> | undefined;
    wire.answer("forge.accounts.add", (params) => {
      sent = params;
      return { result: { receipt: { status: "accepted", sequence: 1, changed: true }, result: { account: forgeRecord({ origin: "https://code.example.test", kind: "gitea" }) } } };
    });
    expect(await detectForge(runtime, env, "https://code.example.test/team/project")).toMatchObject({ ok: false, unrecognised: true, line: "agent-harness does not recognise this site. Choose what it runs." });
    expect(await addPastedForge({ runtime, clock }, env, { url: "https://code.example.test/team/project", kind: "gitea", token: TOKEN })).toMatchObject({ ok: true, line: "david on code.example.test is connected." });
    expect(sent).toMatchObject({ url: "https://code.example.test/team/project", kind: "gitea" });
  });

  it("says an address that names no site in the field's own words and sends no lookup", async () => {
    const { runtime, wire, env } = await paired();
    let asked = 0;
    wire.answer("forge.detect", () => {
      asked += 1;
      return { error: { code: "invalid_params", message: "The URL names no forge." } };
    });
    for (const typed of ["github.com/you/project", "hello", "  "]) {
      expect(await detectForge(runtime, env, typed)).toEqual({ ok: false, unrecognised: false, line: "Enter an address like https://github.com/you/project.", details: [] });
    }
    expect(asked).toBe(0);
  });
});
