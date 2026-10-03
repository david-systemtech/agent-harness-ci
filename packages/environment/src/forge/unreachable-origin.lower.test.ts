import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { startFakeForge, unreachableOrigin } from "../../test/fake-forge.js";

const { onCleanup } = useCleanups();

describe("the unreachable origin fixture", () => {
  it("keeps its port reserved while refusing concurrent requests beside an answering forge", async () => {
    const origin = await unreachableOrigin(onCleanup);
    const other = createServer((_request, response) => {
      response.writeHead(404).end();
    });
    onCleanup(() => new Promise<void>((resolve, reject) => {
      if (!other.listening) return resolve();
      other.close((error) => error ? reject(error) : resolve());
    }));

    // Reproduce port reuse explicitly, rather than wait for the OS to choose this port again.
    await expect(new Promise<void>((resolve, reject) => {
      other.once("error", reject);
      other.listen(Number(new URL(origin).port), "127.0.0.1", resolve);
    })).rejects.toMatchObject({ code: "EADDRINUSE" });

    const forge = await startFakeForge();
    onCleanup(() => forge.close());
    forge.answer(null, "GET /api/v1/version", { status: 200, body: { version: "1.0.0" } });
    await Promise.all(Array.from({ length: 4 }, async () => {
      await expect(fetch(`${origin}/api/v1/version`)).rejects.toThrow();
      expect((await fetch(`${forge.origin}/api/v1/version`)).status).toBe(200);
    }));
  });

  it("releases the port when the caller cleans up", async () => {
    let close = async (): Promise<void> => { throw new Error("The fixture did not register cleanup."); };
    const origin = await unreachableOrigin((cleanup) => {
      close = cleanup;
      onCleanup(cleanup);
    });
    await close();

    const other = createServer();
    onCleanup(() => new Promise<void>((resolve, reject) => {
      other.close((error) => error ? reject(error) : resolve());
    }));
    await new Promise<void>((resolve, reject) => {
      other.once("error", reject);
      other.listen(Number(new URL(origin).port), "127.0.0.1", resolve);
    });
    expect(other.listening).toBe(true);
  });
});
