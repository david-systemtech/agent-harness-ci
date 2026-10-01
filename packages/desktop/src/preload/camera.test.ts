import { JSDOM } from "jsdom";
import { encode } from "uqr";
import { afterEach, expect, it, vi } from "vitest";
import { windowCamera } from "./camera.js";

const windows: JSDOM[] = [];
afterEach(() => { windows.splice(0).forEach((dom) => dom.window.close()); vi.restoreAllMocks(); });

/** Browser APIs scripted at the camera boundary: no hardware, Electron or browser is started. */
const cameraWindow = () => {
  const dom = new JSDOM("<!doctype html><body><button>Scan a QR</button></body>", { url: "https://app.invalid" });
  windows.push(dom);
  const view = dom.window as unknown as Window & typeof globalThis;
  const stop = vi.fn();
  const stream = { getTracks: () => [{ stop }] } as unknown as MediaStream;
  const media = { enumerateDevices: vi.fn(async () => [{ kind: "videoinput" }]), getUserMedia: vi.fn(async () => stream) };
  Object.defineProperty(view.navigator, "mediaDevices", { value: media });
  const frames = new Map<number, FrameRequestCallback>();
  let requested!: () => void;
  const frameRequested = new Promise<void>((resolve) => { requested = resolve; });
  let frameId = 0;
  view.requestAnimationFrame = (callback) => { frames.set(++frameId, callback); requested(); return frameId; };
  view.cancelAnimationFrame = (id) => { frames.delete(id); };
  Object.assign(dom.window.HTMLDialogElement.prototype, {
    showModal(this: HTMLDialogElement) { this.open = true; },
    close(this: HTMLDialogElement) { this.open = false; this.dispatchEvent(new dom.window.Event("close")); },
  });
  vi.spyOn(dom.window.HTMLMediaElement.prototype, "play").mockResolvedValue();
  const image = { data: new Uint8ClampedArray(320 * 320 * 4).fill(255), width: 320, height: 320 };
  vi.spyOn(dom.window.HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: vi.fn(), getImageData: () => image } as unknown as CanvasRenderingContext2D);
  Object.defineProperty(dom.window.HTMLVideoElement.prototype, "videoWidth", { get: () => 320 });
  Object.defineProperty(dom.window.HTMLVideoElement.prototype, "videoHeight", { get: () => 320 });
  return {
    view, media, stream, stop, frames, image, frameRequested,
    frame: () => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach((callback) => callback(0)); },
  };
};

it("shows the camera and decodes one pairing QR with the portable decoder, then releases it", async () => {
  const camera = cameraWindow();
  const link = "agent-harness://pair?address=http%3A%2F%2Fdesk.test%3A7433&code=K7Q2MXH4RT";
  const qr = encode(link, { border: 4 });
  for (let y = 0; y < 320; y++) for (let x = 0; x < 320; x++) {
    const colour = qr.data[Math.floor(y * qr.size / 320)]?.[Math.floor(x * qr.size / 320)] ? 0 : 255;
    const offset = (y * 320 + x) * 4;
    camera.image.data.set([colour, colour, colour, 255], offset);
  }
  const shell = await windowCamera(camera.view);
  const result = shell!.scanQr();
  await camera.frameRequested;
  expect(camera.view.document.querySelector("dialog[open] video")?.getAttribute("aria-label")).toBe("Camera preview");
  expect(camera.media.getUserMedia).toHaveBeenCalledWith({ video: true, audio: false });
  camera.frame();
  expect(await result).toBe(link);
  expect(camera.stop).toHaveBeenCalledOnce();
  expect(camera.view.document.querySelector("dialog")).toBeNull();
  expect(camera.frames.size).toBe(0);
});

it.each(["button", "escape", "close", "pagehide"])("cancels with undefined on %s, stops capture and restores focus", async (how) => {
  const camera = cameraWindow();
  const trigger = camera.view.document.querySelector("button")!;
  trigger.focus();
  const shell = await windowCamera(camera.view);
  const result = shell!.scanQr();
  await camera.frameRequested;
  // A frame with no QR keeps scanning; repeated calls share the same capture.
  camera.frame();
  expect(shell!.scanQr()).toBe(result);
  const dialog = camera.view.document.querySelector("dialog")!;
  if (how === "button") dialog.querySelector("button")!.click();
  if (how === "escape") dialog.dispatchEvent(new camera.view.Event("cancel", { cancelable: true }));
  if (how === "close") dialog.close();
  if (how === "pagehide") camera.view.dispatchEvent(new camera.view.Event("pagehide"));
  expect(await result).toBeUndefined();
  expect(camera.stop).toHaveBeenCalledOnce();
  expect(camera.view.document.activeElement).toBe(trigger);
  expect(camera.frames.size).toBe(0);
  expect(camera.view.document.querySelector("dialog")).toBeNull();
});

it("cancels during a permission prompt and stops a stream that arrives after closing", async () => {
  const camera = cameraWindow();
  let grant!: (stream: MediaStream) => void;
  camera.media.getUserMedia.mockReturnValue(new Promise((resolve) => { grant = resolve; }));
  const shell = await windowCamera(camera.view);
  const result = shell!.scanQr();
  camera.view.document.querySelector<HTMLButtonElement>("dialog button")!.click();
  expect(await result).toBeUndefined();
  grant(camera.stream);
  await Promise.resolve();
  expect(camera.stop).toHaveBeenCalledOnce();
  expect(camera.frames.size).toBe(0);
});

it("reports denied access, removes the modal, and allows a new scan", async () => {
  const camera = cameraWindow();
  camera.media.getUserMedia.mockRejectedValueOnce(new Error("Camera permission denied"));
  const shell = await windowCamera(camera.view);
  await expect(shell!.scanQr()).rejects.toThrow("Camera permission denied");
  expect(camera.view.document.querySelector("dialog")).toBeNull();
  const next = shell!.scanQr();
  await camera.frameRequested;
  camera.view.document.querySelector<HTMLButtonElement>("dialog button")!.click();
  expect(await next).toBeUndefined();
  expect(camera.stop).toHaveBeenCalledOnce();
});

it("omits the camera on an audio-only machine or a failed device probe", async () => {
  const camera = cameraWindow();
  camera.media.enumerateDevices.mockResolvedValueOnce([{ kind: "audioinput" }]);
  expect(await windowCamera(camera.view)).toBeUndefined();
  camera.media.enumerateDevices.mockRejectedValueOnce(new Error("Devices unavailable"));
  expect(await windowCamera(camera.view)).toBeUndefined();
  expect(camera.media.getUserMedia).not.toHaveBeenCalled();
});
