// @vitest-environment node
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";

it("keeps manifest identity, navigation and bundled maskable icons rooted at the canonical origin", async () => {
  const manifest = JSON.parse(await readFile(new URL("../../public/manifest.webmanifest", import.meta.url), "utf8")) as { id: string; start_url: string; scope: string; display: string; icons: { src: string; sizes: string; type: string; purpose: string }[] };
  expect([manifest.id, manifest.start_url, manifest.scope, manifest.display]).toEqual(["/", "/", "/", "standalone"]);
  for (const size of [192, 512]) {
    const icon = manifest.icons.find(icon => icon.sizes === `${size}x${size}`)!;
    expect(icon).toMatchObject({ type: "image/png", purpose: "any maskable" });
    const image = await readFile(new URL(`../../public${icon.src}`, import.meta.url));
    expect([image.readUInt32BE(16), image.readUInt32BE(20)]).toEqual([size, size]);
  }
  const index = await readFile(new URL("../../index.html", import.meta.url), "utf8");
  expect(index).toContain('rel="manifest" href="/manifest.webmanifest"');
});
