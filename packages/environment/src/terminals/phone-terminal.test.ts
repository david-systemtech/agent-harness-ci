import { execFile } from "node:child_process";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { useCleanups } from "../../test/cleanups.js";

const { tempDir } = useCleanups();

/** Real shell execution is restricted to hosted CI, in a separate ordinary-uid process. */
it.skipIf(process.env["GITHUB_ACTIONS"] !== "true" || process.env["RUNNER_ENVIRONMENT"] !== "github-hosted" || process.platform !== "linux")("retains a phone terminal across hiding and reconnect, enforces its grant and closes it explicitly", async () => {
  const root = tempDir("agent-harness-phone-terminal-");
  chmodSync(root, 0o777);
  const worker = join(root, "terminal-proof.mts");
  const source = new URL("../../", import.meta.url);
  // The worker uses production startup and the wire seam helpers, without replacing the user check or PTY.
  writeFileSync(worker, `
    import assert from "node:assert/strict";
    import { mkdirSync } from "node:fs";
    import { join } from "node:path";
    import { startEnvironment } from ${JSON.stringify(new URL("src/serve/start.ts", source).href)};
    import { fileVault } from ${JSON.stringify(new URL("src/serve/vault.ts", source).href)};
    import { connectClient } from ${JSON.stringify(new URL("test/wire-client.ts", source).href)};
    import { sessionIn, openTerminal, typeInto, follow, terminalCommand, refusedWith } from ${JSON.stringify(new URL("test/terminals.ts", source).href)};
    const root = process.env.AGENT_HARNESS_PHONE_PROOF;
    assert.notEqual(process.getuid(), 0);
    const workspace = join(root, "workspace"); mkdirSync(workspace);
    const env = await startEnvironment({ dataDir: join(root, "data"), port: 0, adapters: [], accounts: [],
      vault: fileVault(join(root, "vault.json")),
      interfaces: { tailscaleAddress: async () => undefined, tailnetName: async () => undefined, lanAddresses: () => [] },
      terminals: { shell: () => ({ file: "/bin/sh", args: [] }) },
    });
    const clients = [];
    const connect = async credential => {
      const client = await connectClient(env.address, { token: credential.token, clientKind: "web" });
      clients.push(client); return client;
    };
    try {
      const credential = env.clientSessions.issue({ kind: "web", label: "Expanded phone", scopes: ["read", "sessions:write", "runs:drive", "terminal"], ceiling: "acceptEdits" });
      let phone = await connect(credential);
      const session = await sessionIn(phone, workspace);
      const terminal = await openTerminal(phone, session, { cols: 32, rows: 10 });
      const view = await follow(phone, terminal.id);
      await typeInto(phone, terminal.id, "echo ready-$((6*7))\\r");
      await view.until(v => v.text.includes("ready-42"));
      const cursor = view.cursor;
      phone.send({ type: "unsubscribe", subscription: view.subscription });
      await phone.next(frame => frame.type === "end" && frame.subscription === view.subscription);
      assert.equal((await phone.request("terminals.list", { sessionId: session })).terminals[0].id, terminal.id);
      // A hidden pane has released its subscription, while the same shell continues producing output.
      await typeInto(phone, terminal.id, "echo hidden-$((6*8))\\r");
      await phone.close();
      phone = await connect(credential);
      const replay = await follow(phone, terminal.id, cursor);
      await replay.until(v => v.text.includes("hidden-48"));
      assert.equal(replay.text.includes("ready-42"), false);
      await typeInto(phone, terminal.id, "stty size; echo back-$((7*7))\\r");
      await replay.until(v => v.text.includes("back-49"));
      assert.match(replay.text, /10 32/);
      const narrow = await connect(env.clientSessions.issue({ kind: "web", label: "Phone", scopes: ["read", "sessions:write", "runs:drive"], ceiling: "acceptEdits" }));
      const refused = await refusedWith(narrow.request("terminals.list", { sessionId: session }));
      assert.equal(refused.code, "forbidden");
      await terminalCommand(phone, "terminals.close", { id: terminal.id });
      await replay.until(v => v.exited !== undefined);
      assert.equal(replay.exited.cause, "closed");
      assert.deepEqual((await phone.request("terminals.list", { sessionId: session })).terminals, []);
      console.log("PHONE-TERMINAL-PROOF: command output, hidden retention, reconnect, grant and explicit close passed");
    } finally {
      await Promise.all(clients.map(client => client.close()));
      await env.close();
    }
  `);
  const result = await promisify(execFile)(process.execPath, ["--conditions=@agent-harness/source", "--import", import.meta.resolve("tsx"), worker], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: root, AGENT_HARNESS_PHONE_PROOF: root },
    ...(process.getuid?.() === 0 && { uid: 65534, gid: 65534 }),
    timeout: 120_000,
    maxBuffer: 1024 * 1024,
  });
  expect(result.stdout).toContain("PHONE-TERMINAL-PROOF: command output, hidden retention, reconnect, grant and explicit close passed");
});
