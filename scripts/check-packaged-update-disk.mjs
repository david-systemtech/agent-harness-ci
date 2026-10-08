import process from "node:process";
import { log } from "node:console";
import { setTimeout } from "node:timers";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Removes the check's scratch directory. Windows releases an exited node.exe's image a moment after the exit, and the
// launcher runs each version on the data directory's own Node in it (#1910), so a removal right after the stop is
// retried while the hold lasts (#1940).
export function removeScratch(path, remove = fs.rmSync) {
  remove(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

// The shipped modules, with only disk availability held. No service manager or user data is touched.
export async function checkPackagedUpdateDisk(server) {
  const require = createRequire(join(server, "packages/cli/package.json"));
  const { DATABASE_FILE, LAUNCHER_PROTOCOL } = require("@agent-harness/contracts/launcher");
  const work = fs.mkdtempSync(join(tmpdir(), "packaged-update-disk-"));
  const dataDir = join(work, "data");
  fs.mkdirSync(dataDir);
  const originalStatfs = fs.default.statfsSync;
  let launcher;
  try {
    fs.writeFileSync(join(dataDir, DATABASE_FILE), "user data preserved");
    const { stageArtefact } = await import(pathToFileURL(join(server, "node_modules/@agent-harness/environment/dist/updates/staging.js")));
    fs.default.statfsSync = () => ({ bsize: 4096, bavail: 65536 });
    syncBuiltinESMExports();
    const version = JSON.parse(fs.readFileSync(join(server, "packages/cli/package.json"))).version;
    await assert.rejects(stageArtefact({ dataDir, version, artefact: server, unpack: async () => {} }), /disk space.*staging.*snapshot/i);
    assert.deepEqual(fs.readdirSync(join(dataDir, "staging")), []);
    fs.default.statfsSync = originalStatfs;
    syncBuiltinESMExports();

    const entry = `
      import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      const version = JSON.parse(await (await import('node:fs/promises')).readFile(new URL('../package.json', import.meta.url))).version;
      if (process.argv[2] === 'preflight') {
        console.log(JSON.stringify({ version, protocolVersion: 1, launcherProtocol: ${LAUNCHER_PROTOCOL}, databaseSchemaVersion: 1, bundledClaudeCodeVersion: '1.0.0' }));
      } else {
        const data = process.argv[process.argv.indexOf('--data-dir') + 1];
        const record = (event) => appendFileSync(join(data, 'events'), event + '\\n');
        process.on('message', (m) => {
          if (m.type === 'committed') {
            record('ready ' + version);
            if (!existsSync(join(data, 'asked'))) {
              writeFileSync(join(data, 'asked'), '');
              process.send({ type: 'install?', id: 1, version: '0.6.0', staged: join(data, 'staging/0.6.0') });
            }
          } else if (m.type === 'installed') {
            process.send({ type: 'switch?', id: 2, version: '0.6.0', updateId: '11111111-1111-4111-8111-111111111111' });
          } else if (m.type === 'refused') {
            record('refused ' + m.reason);
            process.exit(0);
          } else if (m.type === 'drain?') process.exit(0);
        });
        process.on('SIGTERM', () => process.exit(0));
        process.send({ type: 'prepared', version });
      }
    `;
    const layout = (folder, version, complete) => {
      const node = join(folder, ...(process.platform === "win32" ? ["node", "node.exe"] : ["node", "bin", "node"]));
      fs.mkdirSync(dirname(node), { recursive: true });
      try { fs.linkSync(process.execPath, node); } catch { fs.copyFileSync(process.execPath, node); }
      fs.mkdirSync(join(folder, "packages/cli/dist"), { recursive: true });
      fs.writeFileSync(join(folder, "packages/cli/package.json"), JSON.stringify({ type: "module", version, launcherProtocol: LAUNCHER_PROTOCOL }));
      fs.writeFileSync(join(folder, "packages/cli/dist/main.js"), entry);
      if (complete) fs.writeFileSync(join(folder, ".complete"), "");
    };
    layout(join(dataDir, "versions/0.5.0"), "0.5.0", true);
    layout(join(dataDir, "versions/0.4.0"), "0.4.0", true);
    layout(join(dataDir, "staging/0.6.0"), "0.6.0", false);
    fs.writeFileSync(join(dataDir, "service-state.json"), JSON.stringify({ activeVersion: "0.5.0", previousVersion: "0.4.0", launcherVersion: "0.5.0", pendingUpdate: null, watchDeadline: null, watchedUpdateId: null, stagedVersion: null, failedHandover: null }));
    const { startLauncher } = await import(pathToFileURL(join(server, "packages/cli/dist/launch/launcher.js")));
    launcher = startLauncher({ dataDir, version: "0.5.0", freeBytes: () => fs.existsSync(join(dataDir, "versions/0.6.0/.complete")) ? 0 : 2 ** 40 });
    const deadline = Date.now() + 120_000;
    while (!fs.existsSync(join(dataDir, "events")) || fs.readFileSync(join(dataDir, "events"), "utf8").split("ready 0.5.0").length < 3) {
      assert.ok(Date.now() < deadline, "The prior environment must restart after refusal");
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.match(fs.readFileSync(join(dataDir, "events"), "utf8"), /refused disk/);
    assert.equal(fs.existsSync(join(dataDir, "versions/0.6.0")), false);
    assert.ok(fs.existsSync(join(dataDir, "versions/0.4.0/.complete")));
    assert.ok(fs.existsSync(join(dataDir, "versions/0.5.0/.complete")));
    assert.equal(fs.readFileSync(join(dataDir, DATABASE_FILE), "utf8"), "user data preserved");
    const state = JSON.parse(fs.readFileSync(join(dataDir, "service-state.json")));
    assert.equal(state.activeVersion, "0.5.0");
    assert.equal(state.launcherVersion, "0.5.0");
    assert.equal(state.stagedVersion, null);
    log("Verified packaged staging budget and refused-switch candidate reclamation");
  } finally {
    fs.default.statfsSync = originalStatfs;
    syncBuiltinESMExports();
    await launcher?.stop();
    removeScratch(work);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert.ok(process.argv[2], "Expected packaged server directory");
  await checkPackagedUpdateDisk(resolve(process.argv[2]));
}
