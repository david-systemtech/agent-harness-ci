import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { log } from "node:console";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL, URL } from "node:url";
import { promisify } from "node:util";

// Runs shipped persistence modules on the real filesystem, with no filesystem stub.
export async function checkPackagedTerminalState(server, dataDir) {
  const require = createRequire(join(server, "packages/cli/package.json"));
  const batchURL = pathToFileURL(require.resolve("@agent-harness/tui/terminal-state"));
  const { commitTerminalBatch, terminalCompletion } = await import(batchURL);
  const { jsonDocuments } = await import(new URL("./json-documents.js", batchURL));
  const { Snippets, SNIPPETS_FILE } = await import(new URL("../composer/snippets.js", batchURL));
  const scratch = mkdtempSync(join(tmpdir(), "packaged-terminal-state-"));
  try {
    const documents = jsonDocuments(join(scratch, "documents"));
    await documents.set("smoke.document", { saved: true });
    assert.deepEqual(await jsonDocuments(join(scratch, "documents")).get("smoke.document"), { saved: true });
    assert.throws(() => commitTerminalBatch(scratch, {
      sourceKey: "smoke-source", snippets: [{ name: "recovered", body: "saved text", updatedAt: 1 }],
    }, { afterCommit: () => { throw new Error("interrupted after commit"); } }), /interrupted after commit/);
    assert.deepEqual(terminalCompletion(scratch, "smoke-source"), ["snippets"]);
    assert.equal((await Snippets.load(join(scratch, SNIPPETS_FILE))).get("recovered")?.body, "saved text");
    log("Verified packaged terminal document write and committed recovery replay");

    if (dataDir) {
      const { selectTerminalEnvironment } = await import(pathToFileURL(require.resolve("@agent-harness/tui/screenless")));
      const version = JSON.parse(readFileSync(join(server, "packages/cli/package.json"), "utf8")).version;
      // Seed through a separate client so the installed CLI still adopts its first local connection itself.
      const selected = await selectTerminalEnvironment({ dataDir, stateDir: join(scratch, "seed"), version,
        report: (message) => { throw new Error(message); } });
      assert.ok(selected.ok, selected.message);
      const { selection } = selected;
      const id = randomUUID();
      try {
        const created = await selection.runtime.commands.dispatch(selection.environment.environmentId, "sessions.create", {
          id, title: "Terminal listing smoke", workspace: { kind: "directory", path: scratch },
        });
        assert.ok(created.ok, JSON.stringify(created));
      } finally { await selection.close(); }

      const stateDir = join(scratch, "cli");
      const run = promisify(execFile);
      const shim = join(dataDir, "bin", "agent-harness.cmd");
      for (const attempt of [1, 2]) {
        const result = await run(process.env.ComSpec, ["/d", "/s", "/c", `""${shim}" ls --all --json"`], {
          env: { ...process.env, AGENT_HARNESS_TUI_STATE_DIR: stateDir }, windowsVerbatimArguments: true,
        });
        const rows = result.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line));
        assert.ok(rows.some((row) => row.environmentId === selection.environment.environmentId && row.summary.id === id && row.summary.title === "Terminal listing smoke"));
        const remembered = JSON.parse(readFileSync(join(stateDir, "documents/local.environment.json"), "utf8"));
        assert.equal(remembered.environmentId, selection.environment.environmentId);
        log(`Verified packaged Windows CLI listing ${attempt}: session JSON and saved local connection`);
      }
    }
  } finally { rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert.ok(process.argv[2], "Expected packaged server directory");
  await checkPackagedTerminalState(resolve(process.argv[2]), process.argv[3] && resolve(process.argv[3]));
}
