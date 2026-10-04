import { useState } from "react";
import { Download, ExternalLink } from "lucide-react";
import { browserInputs } from "../../src/platform/web-inputs.js";
import { Button, Dialog, DialogClose, DialogContent, Input } from "../../src/ui/index.js";
import { DialogFooter } from "../../src/ui/dialog.js";
import { TooltipProvider } from "../../src/ui/tooltip.js";
import { CopyButton } from "../../src/ui/copy-button.js";
export const platform = "web";

/** Shared modal controls and honest clipboard denial, without a desktop shell. */
export default function PhoneOverlayDialog() {
  const [inputs] = useState(() => browserInputs(window));
  return <TooltipProvider><main className="h-dvh bg-abyss p-4 text-ink">
    <Dialog defaultOpen><DialogContent title="Keep a copy of the project notes" description="Files you download stay on this device. The workspace directory stays on the environment.">
      <label className="flex min-w-0 flex-col gap-2 text-sm">File name<Input defaultValue="project-notes-for-the-next-session.txt" /></label>
      <CopyButton text="Project notes with a long line that remains selectable on a small screen." copy={async () => { throw new Error("Clipboard access denied"); }} />
      <Button onClick={() => inputs.download("project-notes.txt", new Blob(["Project notes"], { type: "text/plain" }))}><Download aria-hidden="true" />Download notes</Button>
      <Button onClick={() => void inputs.openExternal("https://example.test/docs")}><ExternalLink aria-hidden="true" />Open documentation</Button>
      <DialogFooter><DialogClose asChild><Button variant="outline">Cancel</Button></DialogClose></DialogFooter>
    </DialogContent></Dialog>
  </main></TooltipProvider>;
}
export const activate = () => {
  let copied = false;
  const show = () => {
    const button = document.querySelector<HTMLButtonElement>('[aria-label="Copy"]');
    if (copied || !button) return;
    copied = true; button.click();
  };
  const observer = new MutationObserver(show);
  observer.observe(document.body, { childList: true, subtree: true });
  show();
  return () => observer.disconnect();
};
export const readySelector = '[aria-label="Text to copy manually"]';
export const geometry = [
  { selector: '[role="dialog"]', visibleWithin: '[role="dialog"]' },
  { selector: '[role="dialog"] button', minimumWidth: 44, minimumHeight: 44 },
  { selector: '[role="dialog"] input', minimumHeight: 44 },
  { selector: '[role="dialog"] textarea', minimumHeight: 44 },
  { selector: '[role="dialog"] button[aria-label="Close dialog"]', visibleWithin: '[role="dialog"]' },
];
