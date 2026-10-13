import type { RunContext } from "../adapter/contract.js";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { fakeAdapter } from "../../test/fake-adapter.js";
import { startTestEnvironment } from "../../test/helper.js";
import { create, deleteSession, purgeSession } from "../../test/sessions.js";

const { onCleanup } = useCleanups();
const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "cGljdHVyZQ==" } };

describe("transcript images over the wire", () => {
  it("keeps a provider image outside the log, fetches it only for its session, and removes it on purge", async () => {
    let recorder: RunContext["recordImage"];
    const adapter = fakeAdapter({ script: function* ({ context }) {
      recorder = context.recordImage;
      yield { type: "tool.started", payload: { toolCallId: "shot", name: "mcp__browser__screenshot", input: {}, title: null, agentId: null, parentToolCallId: null } };
      yield { type: "tool.ended", payload: { toolCallId: "shot", status: "ok", output: [{ type: "text", text: "The page" }, image], durationMs: 1 } };
      yield { type: "end", reason: "completed" };
    } });
    const t = await startTestEnvironment({ adapter });
    onCleanup(() => t.close());
    const client = await t.client();
    const { id } = await create(client);
    const other = await create(client);
    const limited = await t.client({ token: (await t.pair({ scopes: ["sessions:write"] })).token });
    const { subscription } = await client.subscribe("sessions.subscribeSession", { sessionId: id, afterSequence: t.env.log.head() });
    await client.request("runs.start", { commandId: randomUUID(), sessionId: id, text: "Screenshot" });
    await client.next((frame) => frame.type === "event" && frame.subscription === subscription && frame.event.type === "run.ended");
    const ended = t.env.log.readStream({ kind: "session", id }).find((event) => event.type === "tool.ended");
    expect(JSON.stringify(ended)).not.toContain(image.source.data);
    const output = ended?.payload["output"] as { hash: string; mediaType: string; size: number }[];
    const reference = output[1]!;
    expect(reference).toMatchObject({ type: "image", mediaType: "image/png", size: 7, sensitive: true });
    expect(reference.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(await client.request("transcript.image", { sessionId: id, hash: reference.hash })).toEqual({ image: { mediaType: "image/png", data: image.source.data } });
    expect(await client.request("transcript.image", { sessionId: other.id, hash: reference.hash })).toEqual({ image: null });
    await expect(limited.request("transcript.image", { sessionId: id, hash: reference.hash })).rejects.toMatchObject({ code: "forbidden" });
    const forkId = randomUUID();
    await client.request("sessions.fork", { commandId: randomUUID(), sessionId: id, id: forkId });
    expect(await client.request("transcript.image", { sessionId: forkId, hash: reference.hash })).toEqual({ image: { mediaType: "image/png", data: image.source.data } });
    const nestedFork = randomUUID();
    await client.request("sessions.fork", { commandId: randomUUID(), sessionId: forkId, id: nestedFork });
    await deleteSession(client, forkId, false);
    await purgeSession(client, forkId);
    expect(await client.request("transcript.image", { sessionId: nestedFork, hash: reference.hash })).toEqual({ image: { mediaType: "image/png", data: image.source.data } });
    await deleteSession(client, id, false);
    expect(await client.request("transcript.image", { sessionId: id, hash: reference.hash })).toEqual({ image: { mediaType: "image/png", data: image.source.data } });
    await purgeSession(client, id);
    expect(recorder!("image/png", image.source.data).hash).toBeUndefined();
    expect(await client.request("transcript.image", { sessionId: nestedFork, hash: reference.hash })).toEqual({ image: { mediaType: "image/png", data: image.source.data } });
    expect(await client.request("transcript.image", { sessionId: id, hash: reference.hash })).toEqual({ image: null });
  });
});
