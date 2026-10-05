// @vitest-environment jsdom-on-node
import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { ask, fakeAdapter } from "../../../environment/test/fake-adapter.js";
import { startTestEnvironment } from "../../../environment/test/helper.js";
import { create } from "../../../environment/test/sessions.js";
import { untilEvent } from "../../../environment/test/routines.js";
import { phoneFallback } from "./phone-fallback.js";

const close: (() => Promise<void>)[] = [];
afterEach(async () => { for (const stop of close.splice(0).reverse()) await stop(); });

it("the hosted receiver regression waits for a real parked prompt and accepts its signed retry", async () => {
  const adapter = fakeAdapter({ script: ask("permission", { toolName: "Bash", toolCallId: "phone-fallback-call", input: { command: "printf test" }, summary: "Prompt details must not reach the receiver" }, { promptId: "phone-fallback-prompt" }) });
  const environment = await startTestEnvironment({ adapter, webOrigin: "https://example.test:8443" });
  close.push(() => environment.close());
  const receiver = await phoneFallback(environment);
  close.push(() => receiver.close());
  const client = await environment.client();
  const { id: sessionId } = await create(client);
  await client.apply("runs.start", { commandId: randomUUID(), sessionId, text: "Ask once" });
  await untilEvent(environment, { kind: "session", id: sessionId }, event => event.type === "prompt.opened");
  await receiver.verify(sessionId, "https://example.test:8443", "fixture");
  expect((await client.request("attention.targets.list", {})).targets).toEqual([]);
  await client.apply("permissions.prompts.answer", { commandId: randomUUID(), promptId: "phone-fallback-prompt", decision: "allow" });
  await untilEvent(environment, { kind: "session", id: sessionId }, event => event.type === "run.ended");
  expect(adapter.runs[0]?.answers).toHaveLength(1);
});
