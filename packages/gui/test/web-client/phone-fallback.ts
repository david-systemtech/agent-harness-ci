import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { TestEnvironment } from "../../../environment/test/helper.js";
import { untilEvent } from "../../../environment/test/routines.js";
import { verifyStandardWebhook, webhookReceiver } from "../../../environment/test/webhook-receiver.js";
import { attentionStream } from "../../../environment/src/attention/store.js";

/** The external receiver double is isolated on loopback; the environment signs and retries real HTTP. */
export async function phoneFallback(environment: TestEnvironment) {
  const receiver = await webhookReceiver();
  const admin = await environment.client();
  const name = `p-${randomUUID()}`;
  const secret = "token-for-tests";
  try {
    await admin.apply("routines.endpoints.set", { commandId: randomUUID(), name, url: receiver.origin + "/attention", secret: { kind: "pasted", secret } });
    await admin.apply("attention.routes.set", { commandId: randomUUID(), target: { id: name, transport: "webhook", enabled: true, completion: false, configuration: { endpoint: name } } });
  } catch (error) { await receiver.close(); await admin.close(); throw error; }
  return {
    verify: async (sessionId: string, origin: string, engine: string): Promise<void> => {
      receiver.answer({ status: 503 });
      for (const delay of [6000, 60_000]) {
        const after = environment.env.log.head();
        const outcome = untilEvent(environment, attentionStream, event => event.sequence > after && event.type === "attention.delivery.result" && event.payload["targetId"] === name);
        environment.clock.advance(delay);
        await outcome;
        await admin.request("attention.targets.list", {});
        const request = receiver.received.at(-1);
        assert(request && verifyStandardWebhook(secret, request, environment.clock.now()));
        assert.equal(request.method, "POST"); assert.equal(request.path, "/attention");
        assert.deepEqual(JSON.parse(request.body), { message: "A session needs you", url: `${origin}/#/session/${environment.env.id}/${sessionId}` });
        assert(!verifyStandardWebhook(secret, { ...request, body: request.body + " " }, environment.clock.now()), "Tampering fails receiver verification.");
        assert(!verifyStandardWebhook(secret, request, new Date(environment.clock.now().getTime() + 301_000)), "Stale replay fails receiver verification.");
        receiver.answer({ status: 204 });
      }
      assert.equal(receiver.received.length, 2, "Failed acknowledgement produces one bounded retry.");
      assert.equal(receiver.received[0]!.headers["webhook-id"], receiver.received[1]!.headers["webhook-id"], "Receiver can deduplicate by the stable signed delivery id.");
      assert.equal(receiver.received[0]!.body, receiver.received[1]!.body);
      assert.equal(Number(receiver.received[1]!.headers["webhook-timestamp"]) - Number(receiver.received[0]!.headers["webhook-timestamp"]), 60);
      await admin.apply("attention.routes.remove", { commandId: randomUUID(), id: name });
      console.log(`PHONE-FALLBACK PASS ${engine}: real parked ask, signed generic payload, bounded retry, stable id, tamper and replay rejection`);
    },
    close: async (): Promise<void> => {
      try { await admin.apply("attention.routes.remove", { commandId: randomUUID(), id: name }); }
      finally { await admin.close(); await receiver.close(); }
    },
  };
}
