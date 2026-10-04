import type { Runtime, ShellFile } from "@agent-harness/client-runtime";
import type { WebModule } from "./web-registrations.js";

/** Browser operations carry file bytes and text, never environment paths or session state. */
export interface WebInputs {
  openFileContents(options: { readonly title?: string; readonly multiple?: boolean; readonly maxBytes: number }): Promise<readonly ShellFile[]>;
  download(name: string, content: Blob): void;
  writeText(text: string): Promise<void>;
  readText(): Promise<string>;
  openExternal(url: string): Promise<void>;
  dispose(): void;
}

export const browserInputs = (view: Window & typeof globalThis): WebInputs => {
  const pending = new Set<() => void>();
  const urls = new Map<string, number>();
  const release = (url: string) => { view.URL.revokeObjectURL(url); urls.delete(url); };
  const link = (href: string, name?: string) => {
    const anchor = view.document.createElement("a");
    anchor.href = href;
    if (name !== undefined) anchor.download = name;
    else { anchor.target = "_blank"; anchor.rel = "noopener noreferrer"; }
    view.document.body.append(anchor);
    anchor.click();
    anchor.remove();
  };
  return {
    openFileContents(options) {
      return new Promise((resolve, reject) => {
        const input = view.document.createElement("input");
        const returnTo = view.document.activeElement;
        input.type = "file"; input.multiple = options.multiple ?? false;
        input.setAttribute("aria-label", options.title ?? "Choose files");
        input.hidden = true;
        let settled = false;
        const close = () => {
          settled = true; pending.delete(cancel); input.remove();
          if (returnTo instanceof view.HTMLElement && returnTo.isConnected) returnTo.focus();
        };
        const cancel = () => { if (!settled) { close(); resolve([]); } };
        pending.add(cancel);
        input.addEventListener("cancel", cancel, { once: true });
        input.addEventListener("change", () => {
          const files = [...(input.files ?? [])];
          void Promise.all(files.map(async (file): Promise<ShellFile> => ({
            name: file.name, size: file.size,
            bytes: file.size > options.maxBytes ? null : new Uint8Array(await file.arrayBuffer()),
          }))).then(files => { if (!settled) { close(); resolve(files); } }, () => { if (!settled) { close(); reject(new Error("The chosen file could not be read. Choose it again.")); } });
        }, { once: true });
        view.document.body.append(input);
        input.click();
      });
    },
    download(name, content) {
      const url = view.URL.createObjectURL(content);
      try { link(url, name); }
      finally { urls.set(url, view.setTimeout(() => release(url), 1000)); }
    },
    async writeText(text) {
      if (!view.navigator.clipboard?.writeText) throw new Error("Select the text and copy it manually.");
      await view.navigator.clipboard.writeText(text);
    },
    async readText() {
      if (!view.navigator.clipboard?.readText) throw new Error("Paste text with your browser's menu.");
      return view.navigator.clipboard.readText();
    },
    async openExternal(raw) {
      const url = new URL(raw);
      if (!["https:", "http:", "mailto:"].includes(url.protocol)) throw new Error("This link cannot be opened safely. Use an HTTPS page address.");
      link(url.href);
    },
    dispose() {
      for (const cancel of [...pending]) cancel();
      for (const [url, timer] of urls) { view.clearTimeout(timer); release(url); }
    },
  };
};

const registered = new WeakMap<Runtime, WebInputs>();
/** Other browser leaves consume these operations without inventing a desktop shell. */
export const webInputsFor = (runtime: Runtime): WebInputs | undefined => registered.get(runtime);
export const webModule: WebModule = {
  slot: "inputs",
  registration: {
    start(runtime) {
      const inputs = browserInputs(window);
      registered.set(runtime, inputs);
      return () => { inputs.dispose(); registered.delete(runtime); };
    },
  },
};
