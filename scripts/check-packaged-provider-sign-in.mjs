import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { log } from "node:console";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { runInNewContext } from "node:vm";

/** Installed native listener source; only telemetry and configuration are substituted, never callback handling. */
export function nativeOAuthListener(binary) {
  const bytes = readFileSync(binary);
  const marker = bytes.indexOf(Buffer.from("promiseResolver=null;promiseRejecter=null;expectedState=null;pendingResponse=null;"));
  assert.ok(marker >= 0, "The bundled provider's callback listener must be inspectable");
  const start = bytes.lastIndexOf(Buffer.from("class "), marker);
  const ending = "[Symbol.dispose](){this.close()}}";
  const end = bytes.indexOf(Buffer.from(ending), marker);
  assert.ok(start >= 0 && end > marker, "The native listener class must be complete");
  const source = bytes.subarray(start, end + ending.length).toString();
  const name = /^class (\w+)\{/.exec(source)?.[1];
  assert.ok(name, "The native listener must have a class name");
  const imports = bytes.subarray(Math.max(0, start - 3000), start).toString();
  const context = { URL, Buffer };
  for (const match of imports.matchAll(/import\{([^}]+)\}from"[^"]+"/g)) {
    for (const member of match[1].split(",")) {
      const [imported, local = imported] = member.trim().split(" as ");
      context[local] = imported === "createServer" ? createServer : () => undefined;
    }
  }
  const configuration = /([\w$]+)\(\)\.CLAUDEAI_SUCCESS_URL/.exec(source)?.[1];
  if (configuration) context[configuration] = () => ({ CLAUDEAI_SUCCESS_URL: "https://provider.example.test/complete" });
  const Listener = runInNewContext(`${source}; ${name}`, context, { timeout: 1000 });
  return new Listener();
}

/** Real loopback requests while the caller's provider exchange remains pending. No browser or account is used. */
export async function checkProviderSignIn(binary) {
  const listener = nativeOAuthListener(binary);
  const state = "state-for-tests";
  let first;
  try {
    const port = await listener.start();
    const callback = `http://127.0.0.1:${port}/callback`;
    const code = listener.waitForAuthorization(state, () => undefined);
    first = globalThis.fetch(`${callback}?code=first-code&state=${state}`, { redirect: "manual" });
    void first.catch(() => undefined);
    assert.equal(await Promise.race([code, first.then(() => { throw new Error("The browser response ended before its code was resolved"); })]), "first-code");
    const replay = await globalThis.fetch(`${callback}?code=second-code&state=${state}`, { redirect: "manual" });
    assert.equal(replay.status, 200);
    assert.match(await replay.text(), /already finishing/);
    listener.handleSuccessRedirect([], response => { response.writeHead(302, { Location: "https://provider.example.test/complete" }); response.end(); });
    const completed = await first;
    assert.equal(completed.status, 302);
    assert.equal(completed.headers.get("location"), "https://provider.example.test/complete");
    assert.equal(listener.hasPendingResponse(), false);
    listener.close();
    assert.equal(listener.localServer.listening, false);
    await assert.rejects(globalThis.fetch(`${callback}?code=third-code&state=${state}`), { name: "TypeError" });
  } finally {
    listener.close();
    listener.localServer.closeAllConnections();
    await first?.catch(() => undefined);
  }
  const rejected = nativeOAuthListener(binary);
  try {
    const port = await rejected.start();
    const code = rejected.waitForAuthorization(state, () => undefined);
    const refusal = assert.rejects(code, /Invalid state/);
    const response = await globalThis.fetch(`http://127.0.0.1:${port}/callback?code=first-code&state=wrong-state`);
    assert.equal(response.status, 400);
    await refusal;
  } finally {
    rejected.close();
    rejected.localServer.closeAllConnections();
  }
  log("Verified packaged provider callback: first response retained, replay ignored, wrong state refused, listener closed");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "--binary") {
    await checkProviderSignIn(process.argv[3]);
  } else {
    const server = process.argv[2];
    assert.ok(server, "Expected the packaged server directory");
    const require = createRequire(join(resolve(server), "node_modules/@agent-harness/environment/package.json"));
    const sdk = createRequire(require.resolve("@anthropic-ai/claude-agent-sdk"));
    const name = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/${process.platform === "win32" ? "claude.exe" : "claude"}`;
    await checkProviderSignIn(sdk.resolve(name));
  }
}
