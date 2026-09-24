import { PROTOCOL_VERSION, SCOPES } from "@agent-harness/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { KEY, renderApp, type RenderedApp } from "../test/harness.js";

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
    expect(app.runtime().connections.list.read()).toMatchObject([{ kind: "paired", phase: "ready" }]);
    expect(app.frame()).not.toContain("Pair this terminal");
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

  it("answers a malformed /pair with its usage", async () => {
    const app = await launch({ script: { environments: [] } });
    await run(app, "/pair");
    await app.waitFor("Usage: /pair <link>, /pair <address> <code>, or /pair create.");
  });

  // Each typed failure with the runtime's own line for it.
  const failures = [
    ["expired-code", { name: "laptop", reach: "unpaired", pairing: "expired-code" }, {}, "The pairing code has expired"],
    ["used-code", { name: "laptop", reach: "unpaired", pairing: "used-code" }, {}, "The pairing code has been used already"],
    ["unreachable", { name: "laptop", reach: "unpaired", discovery: "nothing" }, {}, "Nothing answered"],
    ["protocol-mismatch", { name: "laptop", reach: "unpaired" }, { protocolVersion: PROTOCOL_VERSION + 1 }, "update the environment"],
    ["not-ready", { name: "laptop", reach: "unpaired", discovery: "starting" }, {}, "starting"],
    [
      "different-environment",
      { name: "laptop", reach: "unpaired", hello: { environmentId: "0199aa00-0000-7000-8000-0000000000ff" } },
      {},
      "not the one its address named",
    ],
  ] as const;

  it.each(failures)("renders the %s failure as one line", async (_reason, environment, options, words) => {
    const app = await launch({ script: { environments: [environment] }, service: { installed: false }, ...options });
    await run(app, `/pair ${app.environment("laptop").wire.link}`);
    await app.waitFor("Not paired: ");
    expect(rowsWith(app.frame(), "Not paired: ")[0]).toContain(words);
    const rows = rowsWith(app.frame(), "Not paired");
    expect(rows).toHaveLength(1);
    const row = rows[0] as string;
    const next = app.frame().split("\n")[app.frame().split("\n").indexOf(row) + 1] ?? "";
    // The line after it is the question line or the composer, not the failure wrapping on.
    expect(next.trim() === "" || next.includes("›"), app.frame()).toBe(true);
    expect(app.runtime().connections.list.read()).toEqual([]);
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

  it("answers absent with the reason without admin, sending nothing", async () => {
    const scopes = SCOPES.filter((s) => s !== "admin");
    const app = await launch({ script: { environments: [{ name: "desk", reach: "local", scopes }] } });
    await app.waitFor("● desk ready");
    await run(app, "/pair create");
    await app.waitFor("Cannot create a pairing code on desk: This client was paired with desk without the admin scope.");
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

  it("needs an environment to mint on", async () => {
    const app = await launch({ script: { environments: [] } });
    await run(app, "/pair create");
    await app.waitFor("There is no environment to create a pairing code on");
  });
});
