import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { noticeEvent } from "../test/events.js";
import { flush } from "./testing/fake-wire.js";
import { usePaired } from "../test/paired.js";

const { paired } = usePaired();

describe("bank credentials are direct commands", () => {
  it("sends the token directly and never persists a credential call in the outbox", async () => {
    const { runtime, wire, env, kept } = await paired({ capabilities: ["banks"] });
    const bankId = randomUUID();
    const params = { bankId, token: "bank-token-for-tests" };
    expect(await runtime.commands.dispatch(env, "banks.credential.set", params)).toMatchObject({ ok: false, commandId: null, error: { code: "direct" } });
    expect(await runtime.commands.dispatch(env, "banks.credential.swap", { bankId, reference: { provider: "openbao", connectionId: randomUUID(), mount: "personal", path: "harness/bank-memory", key: "token" } })).toMatchObject({ ok: false, commandId: null, error: { code: "direct" } });
    wire.answer("banks.credential.set", () => ({ result: { receipt: { status: "accepted", sequence: 1, changed: true }, result: {} } }));
    expect(await runtime.requests.call(env, "banks.credential.set", { commandId: randomUUID(), ...params })).toMatchObject({ ok: true, result: { receipt: { status: "accepted" } } });
    expect(kept()).not.toContain(params.token);
  });
});

it("refreshes the Move items when a bank's credential changes", async () => {
  const { runtime, wire, env, environment } = await paired({ capabilities: ["banks", "keyManagers"] });
  let asked = 0;
  wire.answer("keyManagers.move.list", () => (asked++, { result: { items: [] } }));
  runtime.requests.cached(env, "keyManagers.move.list", {}).subscribe(() => undefined);
  await flush();
  expect(asked).toBe(1);
  environment.event(noticeEvent(1, env, "bank.updated", { bankId: randomUUID(), credential: "stored" }));
  await flush();
  expect(asked).toBe(2);
});
