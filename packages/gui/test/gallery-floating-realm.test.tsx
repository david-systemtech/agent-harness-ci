// @vitest-environment node
import { execFileSync } from "node:child_process";
import { Script } from "node:vm";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("runs the hosted transpiled callback in a page without module helpers", async () => {
  const source = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
    'import { waitForFloatingLayout } from "./packages/gui/gallery/floating-layout.ts"; process.stdout.write(waitForFloatingLayout.toString());',
  ], { cwd: fileURLToPath(new URL("../../../", import.meta.url)), encoding: "utf8" });
  const frames: FrameRequestCallback[] = [];
  let requested!: () => void;
  const firstFrame = new Promise<void>((resolve) => { requested = resolve; });
  const ready: Promise<void> = new Script(`(${source})()`).runInNewContext({
    Event,
    document: { body: new EventTarget(), fonts: { ready: Promise.resolve() }, querySelectorAll: () => [] },
    requestAnimationFrame: (callback: FrameRequestCallback) => { frames.push(callback); requested(); return frames.length; },
  });
  const result = ready.then(() => ({ ok: true }), (error: unknown) => ({ ok: false, error: String(error) }));
  await Promise.race([firstFrame, result]);
  for (let frame = 0; frame < 8; frame++) {
    const draw = frames.shift();
    if (draw === undefined) break;
    draw(0);
    await Promise.resolve();
  }
  expect(frames).toHaveLength(0);
  expect(await result).toEqual({ ok: true });
}, 30_000);
