import type { Shell } from "@agent-harness/client-runtime";
import { default as decoder } from "jsqr";

type ShellCamera = NonNullable<Shell["camera"]>;
// jsQR exports the function itself through CommonJS; its declaration describes an ES default.
const jsQR = decoder as unknown as typeof decoder.default;

/** One modal capture at a time. Only the decoded text crosses the context bridge. */
const cameraScanner = (view: Window): ShellCamera => {
  let active: Promise<string | undefined> | undefined;
  return {
    scanQr() {
      if (active) return active;
      const document = view.document;
      const previouslyFocused = document.activeElement;
      const dialog = document.createElement("dialog");
      dialog.className = "shell-camera";
      dialog.setAttribute("aria-label", "Scan a QR");
      const title = document.createElement("h2");
      title.textContent = "Scan a QR";
      const instructions = document.createElement("p");
      instructions.textContent = "Show the pairing QR from the other machine to this camera.";
      const video = document.createElement("video");
      video.setAttribute("aria-label", "Camera preview");
      video.muted = true;
      video.playsInline = true;
      const close = document.createElement("button");
      close.type = "button";
      close.textContent = "Cancel";
      dialog.append(title, instructions, video, close);
      const canvas = document.createElement("canvas");
      let stream: MediaStream | undefined;
      let frame: number | undefined;
      let finished = false;
      let resolve!: (text: string | undefined) => void;
      let reject!: (error: unknown) => void;
      const result = new Promise<string | undefined>((yes, no) => { resolve = yes; reject = no; });
      active = result;
      const cleanup = () => {
        finished = true;
        if (frame !== undefined) view.cancelAnimationFrame(frame);
        stream?.getTracks().forEach((track) => track.stop());
        video.srcObject = null;
        dialog.remove();
        view.removeEventListener("pagehide", cancel);
        if (previouslyFocused?.isConnected && "focus" in previouslyFocused) (previouslyFocused as HTMLElement).focus();
        active = undefined;
      };
      const finish = (text: string | undefined) => { if (!finished) { cleanup(); resolve(text); } };
      const cancel = () => finish(undefined);
      const fail = (error: unknown) => { if (!finished) { cleanup(); reject(error); } };
      close.addEventListener("click", cancel);
      dialog.addEventListener("cancel", (event) => { event.preventDefault(); cancel(); });
      dialog.addEventListener("close", cancel);
      view.addEventListener("pagehide", cancel);
      const readFrame = () => {
        if (finished) return;
        try {
          if (video.videoWidth > 0 && video.videoHeight > 0) {
            const scale = Math.min(1, 640 / Math.max(video.videoWidth, video.videoHeight));
            canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
            canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
            const context = canvas.getContext("2d", { willReadFrequently: true });
            if (!context) throw new Error("The camera's image cannot be read.");
            context.drawImage(video, 0, 0, canvas.width, canvas.height);
            const image = context.getImageData(0, 0, canvas.width, canvas.height);
            const qr = jsQR(image.data, image.width, image.height);
            if (qr) { finish(qr.data); return; }
          }
          frame = view.requestAnimationFrame(readFrame);
        } catch (error) { fail(error); }
      };
      const begin = async () => {
        document.body.append(dialog);
        dialog.showModal();
        close.focus();
        const acquired = await view.navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        // Closing during the OS permission prompt settles immediately; a late stream is still released.
        if (finished) { acquired.getTracks().forEach((track) => track.stop()); return; }
        stream = acquired;
        video.srcObject = stream;
        await video.play();
        if (!finished) frame = view.requestAnimationFrame(readFrame);
      };
      void begin().catch(fail);
      return result;
    },
  };
};

/** Probe without asking for access or opening the camera. Capture begins only on Scan a QR. */
export const windowCamera = async (view: Window): Promise<ShellCamera | undefined> => {
  try {
    const devices = await view.navigator.mediaDevices?.enumerateDevices();
    if (!devices?.some((device) => device.kind === "videoinput")) return undefined;
  } catch {
    return undefined;
  }
  return cameraScanner(view);
};
