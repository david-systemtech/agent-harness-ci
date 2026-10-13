import assert from "node:assert/strict";
import { log } from "node:console";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

// Shipped adapter, SDK and durable store; only the provider executable is scripted.
export async function checkPackagedResume(server, source = false) {
  const moduleRoot = join(server, source ? "packages/environment/src" : "node_modules/@agent-harness/environment/dist");
  const load = path => import(pathToFileURL(join(moduleRoot, path)));
  const { createClaudeAdapter } = await load("adapters/claude/index.js");
  const { openEventLog } = await load("event-log/event-log.js");
  const { createProviderTranscriptStore } = await load("provider-transcripts/store.js");
  const { EMPTY_PROCESS_ENVIRONMENT } = await load("adapter/process-environment.js");
  const { systemClock: clock } = await load("serve/clock.js");
  const scratch = mkdtempSync(join(tmpdir(), "packaged-resume-"));
  const directory = join(scratch, "account");
  mkdirSync(directory);
  const executable = join(scratch, "provider.mjs");
  const providerSessionId = randomUUID();
  writeFileSync(executable, `
    import { createInterface } from 'node:readline';
    import { randomUUID } from 'node:crypto';
    const session_id = ${JSON.stringify(providerSessionId)};
    const emit = message => process.stdout.write(JSON.stringify({ uuid: randomUUID(), session_id, ...message }) + '\\n');
    const init = () => emit({ type: 'system', subtype: 'init', capabilities: ['msg_lifecycle_v1'], tools: [], mcp_servers: [], slash_commands: [] });
    const result = (num_turns, result) => emit({ type: 'result', subtype: 'success', is_error: false, num_turns, result,
      stop_reason: num_turns ? 'end_turn' : null, duration_ms: 1, duration_api_ms: 0, total_cost_usd: 0, usage: {}, modelUsage: {}, permission_denials: [] });
    for await (const line of createInterface({ input: process.stdin })) {
      const message = JSON.parse(line);
      if (message.type === 'control_request') {
        emit({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id,
          response: message.request.subtype === 'initialize' ? { commands: [], models: [], account: {} } : { rate_limits_available: true, rate_limits: {} } } });
        if (message.request.subtype === 'initialize' && process.argv.some(arg => arg.startsWith('--resume='))) {
          init(); result(0, '');
        }
      } else if (message.type === 'user') {
        init();
        emit({ type: 'assistant', user_message_uuid: message.uuid, message: { id: 'reply', role: 'assistant', model: 'claude-sonnet-4-6',
          content: [{ type: 'text', text: message.message.content }], usage: { input_tokens: 1, output_tokens: 1 } }, parent_tool_use_id: null });
        result(1, 'Answered.');
      }
    }
  `);
  const sessionId = randomUUID();
  const key = { projectKey: sessionId, sessionId: providerSessionId };
  let events;
  let adapter;
  let store;
  const start = () => {
    events = openEventLog({ path: join(scratch, "events.sqlite") });
    store = createProviderTranscriptStore({ log: events, clock });
    adapter = createClaudeAdapter({ clock, sessionStore: store, executablePath: executable,
      hostEnv: { PATH: process.env.PATH ?? "", HOME: scratch }, diagnostic: () => {},
      runCommand: async () => ({ code: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "tester@example.com" }), stderr: "" }) });
  };
  const stop = async () => { await adapter?.stopProcess(sessionId); events?.close(); };
  const context = { broker: { request: async () => ({ decision: "deny" }) }, gate: { check: async () => ({ decision: "allow" }) },
    adopt: () => { throw new Error("Resume bookkeeping must not open another run"); }, reportIdentity: () => {}, recheckAccount: () => {},
    process: { hold: () => {}, unhold: () => {}, exited: () => {} } };
  const run = async (text, target) => {
    const messageId = randomUUID();
    const made = adapter.createRun({ sessionId, runId: randomUUID(), account: { id: "smoke-account", directory },
      workspace: { kind: "directory", path: scratch }, repositoryIdentity: null, model: "sonnet", effort: null,
      mode: "acceptEdits", ceiling: "acceptEdits", instructions: "", target, toolServers: [], trusted: false,
      containment: { level: "off", mechanism: null, scratchDirectory: scratch, temporaryDirectory: scratch, writable: [scratch], readOnly: [], network: true },
      denylist: null, processEnvironment: EMPTY_PROCESS_ENVIRONMENT,
      skillSet: { generation: null, fingerprint: "", members: [], hiddenNativeNames: [] },
      prompt: [{ messageId, text, attachments: [] }] }, context);
    const received = [];
    for await (const event of made.events) received.push(event);
    assert.deepEqual(received.filter(event => event.type === "end").map(event => [event.reason, event.turnCount, event.resultText]), [["completed", 1, "Answered."]]);
    assert.ok(received.some(event => event.type === "assistant.text" && event.payload.text === text), "The message must be answered in its own run");
    made.release();
    return messageId;
  };
  try {
    start();
    const before = await run("Before restart", { kind: "fresh" });
    await store.append(key, [
      { type: "user", uuid: before, parentUuid: null, sessionId: providerSessionId, cwd: scratch, message: { role: "user", content: "Before restart" } },
      { type: "assistant", uuid: "stored-reply", parentUuid: before, sessionId: providerSessionId, cwd: scratch, message: { role: "assistant", content: [{ type: "text", text: "Answered." }] } },
    ]);
    await stop();
    start();
    assert.equal((await store.load(key)).length, 2, "Provider history must survive restart");
    await run("After restart", { kind: "resume", providerSessionId });
    log("Verified packaged resume: persisted history, empty startup completion, first message answered in one turn");
  } finally {
    await stop();
    rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert.ok(process.argv[2], "Expected packaged server directory");
  await checkPackagedResume(resolve(process.argv[2]), process.argv.includes("--source"));
}
