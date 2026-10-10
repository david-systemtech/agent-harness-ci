import type { FakeAnswer } from "@agent-harness/client-runtime/testing/fake-wire";
import { LOCAL_PLACEHOLDER_ID } from "@agent-harness/client-runtime";
import { PROTOCOL_VERSION, SCOPES } from "@agent-harness/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { KEY, renderApp, type RenderedApp } from "../test/harness.js";
import { pairingLine } from "./commands/pair.js";

/**
 * Pairing both ways (docs/specs/tui.md, "First launch"): `/pair <link>` and
 * `/pair <address> <code>` call `connections.add`, each typed failure one
 * line; `/pair create` mints a code for another client with `admin`, and
 * answers absent with the reason without it.
 */

let apps: RenderedApp[] = [];
afterEach(async () => {
  for (const app of apps) await app.unmount();
  apps = [];
});
const launch = async (...args: Parameters<typeof renderApp>) => {
  const app = await renderApp(...args);
  apps.push(app);
  return app;
};

/** Types a command and sends it. */
const run = async (app: RenderedApp, command: string) => {
  await app.type(command);
  await app.press(KEY.enter);
};

const rowsWith = (frame: string, text: string) => frame.split("\n").filter((row) => row.includes(text));

describe("/pair", () => {
  it("pairs from a link", async () => {
    const app = await launch({ script: { environments: [{ name: "laptop", reach: "unpaired" }] } });
    await run(app, `/pair ${app.environment("laptop").wire.link}`);
    await app.waitFor("Paired with laptop.");
    await app.waitFor("● laptop ready");
    // Beside the placeholder the runtime lists for this machine, which has no environment running (#181).
    expect(app.runtime().connections.list.read().filter((r) => r.environmentId !== LOCAL_PLACEHOLDER_ID)).toMatchObject([{ kind: "paired", phase: "ready" }]);
    expect(app.frame()).not.toContain("Pair this terminal");
    const laptop = app.environment("laptop");
    await app.waitUntil(() => laptop.requests("setup.check").length === 1, "the paired machine's check");
    expect(laptop.requests("setup.check")[0]?.params).toEqual({ step: "your-machines" });
  });

  it("pairs from an address and a code, the code typed in its two groups", async () => {
    const app = await launch({ script: { environments: [{ name: "laptop", reach: "unpaired" }] } });
    const { origin } = app.environment("laptop").wire;
    await run(app, `/pair ${origin} K7Q2M XH4RT`);
    await app.waitFor("Paired with laptop.");
  });

  it("offers to pair a saved environment again in place, and does on y", async () => {
    const app = await launch({ script: { environments: [{ name: "laptop", reach: "paired" }] } });
    await run(app, `/pair ${app.environment("laptop").wire.link}`);
    await app.waitFor("laptop is paired already. Pair it again in place? y/n");
    await app.press("y");
    await app.waitFor("Paired with laptop.");
  });

  it("makes the environment --environment names the last used once it is paired, though it was not known at launch", async () => {
    const app = await launch({ script: { environments: [{ name: "laptop", reach: "unpaired" }] }, flags: { environment: "laptop" } });
    await app.waitFor("No environment named laptop is known here");
    await run(app, `/pair ${app.environment("laptop").wire.link}`);
    await app.waitFor("● laptop ready");
    await app.waitUntil(
      () => app.runtime().preferences.read()["environments.lastUsed"] === app.environment("laptop").environmentId,
      "laptop the last used",
    );
  });

  it.each(["/pair", "/pair laptop.test 1234 extra", "/pair http://laptop.test:7433/pair#K7Q2MXH4RT extra", "/pair a b c d"])(
    "answers the malformed %j with its usage, sending nothing",
    async (typed) => {
      const app = await launch({ script: { environments: [] } });
      await run(app, typed);
      await app.waitFor("Usage: /pair <link>, /pair <address> <code>, or /pair create.");
      expect(app.frame()).not.toContain("Pairing with");
    },
  );

  // Each typed failure with the runtime's own line for it.
  const failures = [
    ["expired-code", { name: "laptop", reach: "unpaired", pairing: "expired-code" }, {}, "This code has run out"],
    ["used-code", { name: "laptop", reach: "unpaired", pairing: "used-code" }, {}, "This code was already used"],
    ["unreachable", { name: "laptop", reach: "unpaired", discovery: "nothing" }, {}, "Nothing answered"],
    ["protocol-mismatch", { name: "laptop", reach: "unpaired" }, { protocolVersion: PROTOCOL_VERSION + 1 }, "Update laptop, then pair again"],
    ["not-ready", { name: "laptop", reach: "unpaired", discovery: "starting" }, {}, "still starting"],
    [
      "different-environment",
      { name: "laptop", reach: "unpaired", hello: { environmentId: "0199aa00-0000-7000-8000-0000000000ff" } },
      {},
      "reaches a different computer",
    ],
  ] as const;

  it.each(failures)("renders the %s failure as one message, in the runtime's plain words", async (_reason, environment, options, words) => {
    const app = await launch({ script: { environments: [environment] }, service: { installed: false }, ...options });
    await run(app, `/pair ${app.environment("laptop").wire.link}`);
    await app.waitFor("Not paired: ");
    // A plain line may be longer than the frame is wide: it wraps at word breaks, and is said once.
    await app.waitFor(words);
    expect(rowsWith(app.frame(), "Not paired")).toHaveLength(1);
    expect(app.runtime().connections.list.read().map((r) => r.environmentId)).toEqual([LOCAL_PLACEHOLDER_ID]);
  });

  it("says the raw failure behind the plain line after it, as the GUI's Details holds it, and nothing more without one", () => {
    const failure = { reason: "unreachable", message: "Nothing answered at laptop.test:7433." } as const;
    expect(pairingLine({ status: "failed", failure: { ...failure, details: ["http://laptop.test:7433: fetch failed", "ECONNREFUSED"] } }, [])).toBe(
      "Not paired: Nothing answered at laptop.test:7433. Details: http://laptop.test:7433: fetch failed; ECONNREFUSED",
    );
    expect(pairingLine({ status: "failed", failure }, [])).toBe("Not paired: Nothing answered at laptop.test:7433.");
  });
});

describe("/pair create", () => {
  it("mints a code with admin and prints the link, the short code and a QR in block characters", async () => {
    const app = await launch({ script: { environments: [{ name: "desk", reach: "local" }] } });
    await app.waitFor("● desk ready");
    await run(app, "/pair create");
    await app.waitFor("Code: K7Q2M-XH4R");
    const frame = app.frame();
    expect(frame).toContain(`${app.environment("desk").wire.origin}/pair#K7Q2MXH4R`);
    expect(frame).toMatch(/Pair a client with desk before \d\d:\d\d/);
    expect(frame).toMatch(/[▀▄█]{6,}/);
    expect(app.environment("desk").requests("access.pairings.create")).toHaveLength(1);
    await app.press(KEY.esc);
    expect(app.frame()).not.toContain("Code: K7Q2M");
  });

  it("leaves a card opened while the code was being minted, and gives the link and the code on the line", async () => {
    const app = await launch({ script: { environments: [{ name: "desk", reach: "local" }] } });
    await app.waitFor("● desk ready");
    const desk = app.environment("desk");
    let answer!: (value: FakeAnswer) => void;
    desk.wire.answer("access.pairings.create", () => new Promise<FakeAnswer>((resolve) => (answer = resolve)));
    await run(app, "/pair create");
    await app.waitFor("Creating a pairing code on desk…");
    await run(app, "/environment");
    await app.waitFor("Environments");
    answer({
      result: {
        receipt: { status: "accepted", sequence: 7, changed: true },
        result: {
          pairingId: "0199dd00-0000-7000-8000-000000000009",
          code: "K7Q2MXH4RZ",
          link: `${desk.wire.origin}/pair#K7Q2MXH4RZ`,
          expiresAt: "2026-09-24T00:10:00.000Z",
          scopes: [...SCOPES],
          ceiling: "bypassPermissions",
        },
      },
    });
    await app.waitFor(`Pairing code for desk: ${desk.wire.origin}/pair#K7Q2MXH4RZ (K7Q2M-XH4RZ)`);
    expect(app.frame()).toContain("Environments");
    expect(app.frame()).not.toContain("Pair a client with desk before");
  });

  it("answers absent with the reason without admin, sending nothing", async () => {
    const scopes = SCOPES.filter((s) => s !== "admin");
    const app = await launch({ script: { environments: [{ name: "desk", reach: "local", scopes }] } });
    await app.waitFor("● desk ready");
    await run(app, "/pair create");
    await app.waitFor("Cannot create a pairing code on desk: This app has limited access to desk, so it cannot change settings or sign in accounts. Pair again with full access to change this.");
    expect(app.environment("desk").requests("access.pairings.create")).toHaveLength(0);
  });

  it("says the rejection when the environment rejects the command", async () => {
    const app = await launch({
      script: { environments: [{ name: "desk", reach: "local", receipts: { "access.pairings.create": { rejected: "conflict", message: "Too many codes." } } }] },
    });
    await app.waitFor("● desk ready");
    await run(app, "/pair create");
    await app.waitFor("Creating a pairing code on desk was rejected: Too many codes.");
  });

  it("says why it cannot mint on this machine when it has no environment running", async () => {
    const app = await launch({ script: { environments: [] } });
    await run(app, "/pair create");
    await app.waitFor("Cannot create a pairing code on this machine:");
  });
});
