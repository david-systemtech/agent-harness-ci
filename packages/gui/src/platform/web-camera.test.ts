import { afterEach, expect, it, vi } from "vitest";
import { encode } from "uqr";
import { browserCamera, decodePairingQr } from "./web-camera.js";

afterEach(() => { vi.restoreAllMocks(); document.body.replaceChildren(); });
it("cancel stops an active camera and keeps manual pairing available", async () => {
  const stop = vi.fn();
  const camera = browserCamera(window, async () => ({ getTracks: () => [{ stop }] }) as unknown as MediaStream);
  const pending = camera.scanQr();
  await vi.waitFor(() => expect(document.querySelector('video')).not.toBeNull());
  (document.querySelector('[data-camera-cancel]') as HTMLButtonElement).click();
  await expect(pending).resolves.toBeUndefined();
  expect(stop).toHaveBeenCalledOnce();
  expect(document.querySelector('video')).toBeNull();
});
it("a stream granted after cancellation is stopped without reopening the modal", async () => {
  let grant!: (stream: MediaStream) => void;
  const stop = vi.fn();
  const camera = browserCamera(window, () => new Promise(resolve => { grant = resolve; }));
  const pending = camera.scanQr();
  camera.dispose();
  await expect(pending).resolves.toBeUndefined();
  grant({ getTracks: () => [{ stop }] } as unknown as MediaStream);
  await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
  expect(document.querySelector('video')).toBeNull();
});
it("permission denial closes the preview and explains manual pairing", async () => {
  const camera = browserCamera(window, async () => { throw new DOMException("Denied", "NotAllowedError"); });
  await expect(camera.scanQr()).rejects.toThrow("Paste a pairing link or type the address and code");
  expect(document.querySelector('video')).toBeNull();
});

const qrPixels = (link: string) => {
  const { data } = encode(link, { border: 4 });
  const scale = 4; const width = data.length * scale;
  const pixels = new Uint8ClampedArray(width * width * 4);
  for (let y = 0; y < width; y++) for (let x = 0; x < width; x++) {
    const offset = (y * width + x) * 4;
    const value = data[Math.floor(y / scale)]?.[Math.floor(x / scale)] ? 0 : 255;
    pixels[offset] = value; pixels[offset + 1] = value; pixels[offset + 2] = value; pixels[offset + 3] = 255;
  }
  return { data: pixels, width, height: width };
};
it("decodes an HTTPS pairing QR with the portable decoder", () => {
  const link = "https://environment.example.test:8443/pair#K7Q2MXH4RT";
  const image = qrPixels(link);
  expect(decodePairingQr(image.data, image.width, image.height)).toBe(link);
});
it("a successful scan stops tracks and returns focus before pairing", async () => {
  const action = document.createElement("button"); document.body.append(action); action.focus();
  const link = "https://environment.example.test/pair#K7Q2MXH4RT";
  const image = qrPixels(link);
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, "readyState", "get").mockReturnValue(2);
  vi.spyOn(HTMLVideoElement.prototype, "videoWidth", "get").mockReturnValue(image.width);
  vi.spyOn(HTMLVideoElement.prototype, "videoHeight", "get").mockReturnValue(image.height);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: vi.fn(), getImageData: () => image } as unknown as CanvasRenderingContext2D);
  let frameReady!: (callback: FrameRequestCallback) => void;
  const frame = new Promise<FrameRequestCallback>(resolve => { frameReady = resolve; });
  vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => { frameReady(callback); return 1; });
  const stop = vi.fn();
  const camera = browserCamera(window, async () => ({ getTracks: () => [{ stop }] }) as unknown as MediaStream);
  const result = camera.scanQr();
  (await frame)(0);
  await expect(result).resolves.toBe(link);
  expect(stop).toHaveBeenCalledOnce();
  expect(document.activeElement).toBe(action);
  expect(document.querySelector("video")).toBeNull();
});
