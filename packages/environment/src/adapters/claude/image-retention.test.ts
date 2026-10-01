import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { registry } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { useCleanups } from "../../../test/cleanups.js";
import { fakeAdapter } from "../../../test/fake-adapter.js";
import { startTestEnvironment } from "../../../test/helper.js";
import { create, deleteSession, listStream, purgeSession } from "../../../test/sessions.js";
import { createClaudeAdapter } from "./index.js";

/** The session lifecycle over the wire, with scripted provider turns and the real adapter's file deletion. */
const { onCleanup, tempDir } = useCleanups();
const PROVIDER = "5d1e9c3a-7b2f-4e8d-9a6c-3f0b1e2d4c5a";

describe("tool image retention (#622)", () => {
  it.each([
    { adopted: false, deleteProviderTranscript: true, removed: true, outcome: "deleted" },
    { adopted: false, deleteProviderTranscript: false, removed: false, outcome: "kept" },
    { adopted: true, deleteProviderTranscript: true, removed: false, outcome: "kept" },
  ])("purges with adopted=$adopted, deleteProviderTranscript=$deleteProviderTranscript: image removed=$removed", async ({ adopted, deleteProviderTranscript, removed, outcome }) => {
    const directory = tempDir();
    const cleaner = createClaudeAdapter({ executablePath: null });
    const scripted = fakeAdapter({ deleteTranscript: true });
    const t = await startTestEnvironment({
      adapter: { ...scripted, deleteTranscript: cleaner.deleteTranscript! },
      accounts: [{ id: "adopted", provider: scripted.descriptor.provider, directory }],
    });
    onCleanup(() => t.close());
    const client = await t.client();
    let accountId = "adopted";
    let accountDirectory = directory;
    if (!adopted) {
      const added = registry["accounts.add"].response.parse(await client.request("accounts.add", { commandId: randomUUID(), label: "Owned" }));
      const account = added.result?.account;
      if (account === undefined) throw new Error("No owned account was added.");
      accountId = account.id;
      accountDirectory = account.directory.path;
      await client.request("accounts.refresh", { accountId });
    }
    const { id } = await create(client, { account: accountId });
    const { subscription } = await client.subscribe("sessions.subscribeSession", { sessionId: id, afterSequence: t.env.log.head() });
    const started = registry["runs.start"].response.parse(await client.request("runs.start", { commandId: randomUUID(), sessionId: id, text: "Screenshot" }));
    expect(started.receipt.status).toBe("accepted");
    await client.next((frame) => frame.type === "event" && frame.subscription === subscription && frame.event.type === "run.ended");
    client.send({ type: "unsubscribe", subscription });

    const results = join(accountDirectory, "projects", id, PROVIDER, "tool-results");
    mkdirSync(results, { recursive: true });
    const image = join(results, "mcp-browser-blob-1-test.jpeg");
    writeFileSync(image, "image-for-tests");

    expect((await deleteSession(client, id, deleteProviderTranscript)).receipt.status).toBe("accepted");
    expect(readFileSync(image, "utf8")).toBe("image-for-tests");
    const list = await listStream(client, t.env.log.head());
    expect((await purgeSession(client, id)).receipt.status).toBe("accepted");
    expect(existsSync(image)).toBe(!removed);
    expect((await list.next()).payload).toEqual({
      providerTranscript: adopted
        ? { outcome, reason: "adopted-directory" }
        : { outcome },
    });
  });
});
