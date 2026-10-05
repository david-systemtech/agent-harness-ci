import decoder from "jsqr";
// The package ships a CommonJS callable with an ES-default declaration.
const jsQR = decoder as unknown as typeof decoder.default;
import type { Runtime } from "@agent-harness/client-runtime";
import type { WebModule } from "./web-registrations.js";

export interface WebCamera {
  scanQr(): Promise<string | undefined>;
  cancel(): void;
  dispose(): void;
}
/** Portable decoder also works where the browser has no BarcodeDetector. */
export const decodePairingQr = (pixels: Uint8ClampedArray, width: number, height: number): string | undefined => jsQR(pixels, width, height)?.data;

/** Every exit owns track cleanup, including a permission request completing after Cancel. */
export const browserCamera = (
  view: Window & typeof globalThis,
  acquire: () => Promise<MediaStream> = () => {
    if (!view.isSecureContext || !view.navigator.mediaDevices?.getUserMedia) throw new Error("Camera scanning needs HTTPS and camera support. Paste a pairing link or type the address and code.");
    return view.navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
  },
): WebCamera => {
  let cancel: (() => void) | undefined;
  const camera: WebCamera = {
    scanQr() {
      cancel?.();
      return new Promise((resolve, reject) => {
        const returnTo = view.document.activeElement;
        const dialog = view.document.createElement("dialog");
        dialog.className = "web-camera rounded-lg border border-hairline bg-float p-4 text-ink";
        dialog.setAttribute("aria-label", "Scan a pairing QR");
        const heading = view.document.createElement("h2"); heading.textContent = "Scan a pairing QR";
        const explanation = view.document.createElement("p"); explanation.textContent = "Point at the pairing QR. Cancel to paste a link or type the address and code.";
        const video = view.document.createElement("video");
        video.muted = true; video.autoplay = true; video.playsInline = true;
        video.setAttribute("aria-label", "Camera preview");
        const button = view.document.createElement("button"); button.type = "button"; button.textContent = "Cancel";
        button.title = "Cancel camera scan (Escape)"; button.dataset["cameraCancel"] = "";
        dialog.append(heading, explanation, video, button);
        let stream: MediaStream | undefined;
        let frame: number | undefined;
        let closed = false;
        const finish = (result?: string, error?: Error) => {
          if (closed) return;
          closed = true;
          stream?.getTracks().forEach(track => track.stop());
          video.srcObject = null;
          if (frame !== undefined) view.cancelAnimationFrame(frame);
          view.removeEventListener("pagehide", close);
          dialog.remove();
          cancel = undefined;
          if (returnTo instanceof view.HTMLElement && returnTo.isConnected) returnTo.focus();
          if (error) reject(error); else resolve(result);
        };
        const close = () => finish();
        cancel = close;
        button.onclick = close;
        dialog.addEventListener("cancel", event => { event.preventDefault(); close(); });
        dialog.addEventListener("close", close);
        view.addEventListener("pagehide", close);
        // Remain inside the active Radix modal's pointer, focus and accessibility boundary.
        const modal = returnTo instanceof view.Element ? returnTo.closest('[role="dialog"], [role="alertdialog"]') : null;
        (modal ?? view.document.body).append(dialog);
        if (typeof dialog.showModal === "function") dialog.showModal();
        else { dialog.setAttribute("open", ""); dialog.setAttribute("role", "dialog"); dialog.setAttribute("aria-modal", "true"); }
        button.focus();
        const canvas = view.document.createElement("canvas");
        const scan = () => {
          if (closed) return;
          try {
            if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) {
              const scale = Math.min(1, 640 / Math.max(video.videoWidth, video.videoHeight));
              canvas.width = Math.max(1, Math.round(video.videoWidth * scale)); canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
              const context = canvas.getContext("2d", { willReadFrequently: true });
              if (!context) throw new Error("The camera image cannot be read.");
              context.drawImage(video, 0, 0, canvas.width, canvas.height);
              const result = decodePairingQr(context.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height);
              if (result !== undefined) { finish(result); return; }
            }
          } catch { finish(undefined, new Error("The camera image cannot be read. Paste a pairing link or type the address and code.")); return; }
          frame = view.requestAnimationFrame(scan);
        };
        Promise.resolve().then(acquire).then(async granted => {
          if (closed) { granted.getTracks().forEach(track => track.stop()); return; }
          stream = granted; video.srcObject = granted;
          await video.play();
          if (!closed) frame = view.requestAnimationFrame(scan);
        }).catch(() => finish(undefined, new Error("Camera unavailable or permission denied. Paste a pairing link or type the address and code.")));
      });
    },
    cancel() { cancel?.(); },
    dispose() { cancel?.(); },
  };
  return camera;
};
const registered = new WeakMap<Runtime, WebCamera>();
export const webCameraFor = (runtime: Runtime): WebCamera | undefined => registered.get(runtime);
export const webModule: WebModule = {
  slot: "camera", registration: { start(runtime) {
    const camera = browserCamera(window); registered.set(runtime, camera);
    return () => { camera.dispose(); registered.delete(runtime); };
  } },
};
